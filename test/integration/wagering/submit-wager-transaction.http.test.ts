import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { type INestApplication, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ApiModule } from "../../../src/app.module";
import { MetricsService } from "../../../src/shared/infrastructure/observability/metrics.service";
import { ObservabilityModule } from "../../../src/shared/infrastructure/observability/observability.module";
import { PersistenceModule } from "../../../src/shared/infrastructure/persistence/persistence.module";
import { createTestDatabase, type TestDatabaseContext } from "../../support/database";
import { assertLedgerMatchesBalance } from "../../support/invariants";

interface ErrorEnvelope {
  error: { code: string; message: string; details?: Array<{ path: string; message: string }> };
  correlationId: string;
}

interface SubmitBody {
  transactionId: string;
  status: string;
  balance: { amount: string; currency: string };
  idempotentReplay: boolean;
  failureCode?: string;
}

describe("POST /wagering/transactions", () => {
  let db: TestDatabaseContext;
  let app: INestApplication;
  let baseUrl: string;
  let sequence = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    // O lock_timeout é lido na criação do módulo; curto para o teste de 503 não esperar 2 s.
    const previousLockTimeout = process.env.DB_LOCK_TIMEOUT_MS;
    process.env.DB_LOCK_TIMEOUT_MS = "300";

    @Module({
      imports: [
        PersistenceModule.forRoot(db.orm.em),
        ObservabilityModule.forRoot({ level: "silent" }),
        ApiModule,
      ],
    })
    class TestAppModule {}

    app = await NestFactory.create(TestAppModule, { logger: false });
    await app.listen(0);
    baseUrl = await app.getUrl();
    if (previousLockTimeout === undefined) {
      delete process.env.DB_LOCK_TIMEOUT_MS;
    } else {
      process.env.DB_LOCK_TIMEOUT_MS = previousLockTimeout;
    }
  });

  afterAll(async () => {
    await app.close();
    await db.teardown();
  });

  async function createWallet(balance: string): Promise<{ id: string; playerId: string }> {
    sequence += 1;
    const playerId = `http-wager-player-${sequence}`;
    const response = await fetch(`${baseUrl}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ playerId, initialBalance: { amount: balance, currency: "BRL" } }),
    });
    const body = (await response.json()) as { id: string };
    return { id: body.id, playerId };
  }

  function validBody(wallet: { id: string; playerId: string }, overrides: Record<string, unknown> = {}) {
    sequence += 1;
    return {
      providerId: "provider-http",
      externalTransactionId: `ext-http-${sequence}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "round-http",
      gameId: "game-http",
      kind: "BET",
      money: { amount: "25.00", currency: "BRL" },
      ...overrides,
    };
  }

  function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  async function transactionCount(walletId: string): Promise<number> {
    const [row] = await db.orm.em.execute<Array<{ n: string }>>(
      "SELECT COUNT(*) AS n FROM wager_transactions WHERE wallet_id = ? AND kind <> 'OPENING'",
      [walletId],
    );
    return Number(row?.n);
  }

  it("processes a BET and answers 201 with the documented shape", async () => {
    const wallet = await createWallet("1000.00");
    const body = validBody(wallet);

    const response = await post(body, {
      "Idempotency-Key": `${body.providerId}:${body.externalTransactionId}`,
    });

    expect(response.status).toBe(201);
    const payload = (await response.json()) as SubmitBody;
    expect(payload).toEqual({
      transactionId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/),
      status: "PROCESSED",
      balance: { amount: "975.00", currency: "BRL" },
      idempotentReplay: false,
    });
    await assertLedgerMatchesBalance(wallet.id, db.orm.em);
  });

  it("accepts a LOSS with a zero amount", async () => {
    const wallet = await createWallet("100.00");

    const response = await post(validBody(wallet, { kind: "LOSS", money: { amount: "0.00", currency: "BRL" } }), {
      "Idempotency-Key": "loss-zero",
    });

    expect(response.status).toBe(201);
    expect(((await response.json()) as SubmitBody).balance.amount).toBe("100.00");
  });

  describe("outcomes and status codes", () => {
    it("answers 200 with idempotentReplay for a repeated processed request, with the original balance", async () => {
      const wallet = await createWallet("100.00");
      const body = validBody(wallet, { money: { amount: "40.00", currency: "BRL" } });
      const headers = { "Idempotency-Key": "replay-processed" };
      const first = (await (await post(body, headers)).json()) as SubmitBody;
      await post(validBody(wallet, { kind: "WIN", money: { amount: "500.00", currency: "BRL" } }), {
        "Idempotency-Key": "replay-processed-win",
      });

      const replay = await post(body, headers);

      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual({ ...first, idempotentReplay: true });
      expect(first.balance.amount).toBe("60.00");
      await assertLedgerMatchesBalance(wallet.id, db.orm.em);
    });

    it("answers 422 REJECTED with the failure code, and 422 again on replay", async () => {
      const wallet = await createWallet("10.00");
      const body = validBody(wallet, { money: { amount: "80.00", currency: "BRL" } });
      const headers = { "Idempotency-Key": "rejected-funds" };

      const first = await post(body, headers);
      const replay = await post(body, headers);

      expect(first.status).toBe(422);
      expect(await first.json()).toEqual({
        transactionId: expect.any(String),
        status: "REJECTED",
        failureCode: "INSUFFICIENT_FUNDS",
        balance: { amount: "10.00", currency: "BRL" },
        idempotentReplay: false,
      });
      expect(replay.status).toBe(422);
      const replayBody = (await replay.json()) as SubmitBody;
      expect(replayBody.idempotentReplay).toBe(true);
      expect(replayBody.failureCode).toBe("INSUFFICIENT_FUNDS");
      await assertLedgerMatchesBalance(wallet.id, db.orm.em);
    });

    it("answers 202 PENDING_REFERENCE when the reference is unknown, and 202 on replay", async () => {
      const wallet = await createWallet("100.00");
      const body = validBody(wallet, { kind: "REFUND", referenceExternalTransactionId: "not-there-yet" });
      const headers = { "Idempotency-Key": "pending-ref" };

      const first = await post(body, headers);
      const replay = await post(body, headers);

      expect(first.status).toBe(202);
      expect(await first.json()).toEqual({
        transactionId: expect.any(String),
        status: "PENDING_REFERENCE",
        balance: { amount: "100.00", currency: "BRL" },
        idempotentReplay: false,
      });
      expect(replay.status).toBe(202);
      expect(((await replay.json()) as SubmitBody).idempotentReplay).toBe(true);
    });

    it("reverses a processed BET through the API", async () => {
      const wallet = await createWallet("100.00");
      const bet = validBody(wallet, { externalTransactionId: "bet-to-refund" });
      await post(bet, { "Idempotency-Key": "bet-to-refund" });

      const refund = await post(
        validBody(wallet, { kind: "REFUND", referenceExternalTransactionId: "bet-to-refund" }),
        { "Idempotency-Key": "refund-of-bet" },
      );

      expect(refund.status).toBe(201);
      expect(((await refund.json()) as SubmitBody).balance.amount).toBe("100.00");
    });

    it("answers 409 IDEMPOTENCY_CONFLICT for the same key with a different payload", async () => {
      const wallet = await createWallet("100.00");
      const body = validBody(wallet);
      const headers = { "Idempotency-Key": "conflict-key" };
      await post(body, headers);

      const response = await post({ ...body, money: { amount: "26.00", currency: "BRL" } }, headers);

      expect(response.status).toBe(409);
      const envelope = (await response.json()) as ErrorEnvelope;
      expect(envelope.error.code).toBe("IDEMPOTENCY_CONFLICT");
      expect(envelope.correlationId).toBe(response.headers.get("x-correlation-id") ?? "");
      expect(await transactionCount(wallet.id)).toBe(1);
    });

    it("answers 409 IDEMPOTENCY_CONFLICT for the same (provider, external id) under another key", async () => {
      const wallet = await createWallet("100.00");
      const body = validBody(wallet);
      await post(body, { "Idempotency-Key": "first-key" });

      const response = await post(body, { "Idempotency-Key": "second-key" });

      expect(response.status).toBe(409);
      expect(((await response.json()) as ErrorEnvelope).error.code).toBe("IDEMPOTENCY_CONFLICT");
    });

    it("answers 404 WALLET_NOT_FOUND for an unknown wallet", async () => {
      const ghost = { id: "0192f291-27dd-7d3f-8071-5f8685deef37", playerId: "ghost" };

      const response = await post(validBody(ghost), { "Idempotency-Key": "ghost-wallet" });

      expect(response.status).toBe(404);
      expect(((await response.json()) as ErrorEnvelope).error.code).toBe("WALLET_NOT_FOUND");
    });

    it("answers 503 TRANSIENT_FAILURE with Retry-After when the wallet lock times out, then succeeds on retry", async () => {
      const wallet = await createWallet("100.00");
      const body = validBody(wallet);
      const headers = { "Idempotency-Key": "lock-timeout" };
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked!: () => void;
      const lockAcquired = new Promise<void>((resolve) => {
        locked = resolve;
      });
      // Outra transação segura a linha da wallet, como faria uma requisição lenta.
      const holder = db.orm.em.fork().transactional(async (em) => {
        await em.execute("SELECT id FROM wallets WHERE id = ? FOR NO KEY UPDATE", [wallet.id]);
        locked();
        await held;
      });
      await lockAcquired;

      let blocked: Response;
      try {
        blocked = await post(body, headers);
      } finally {
        release();
        await holder;
      }

      expect(blocked.status).toBe(503);
      expect(blocked.headers.get("retry-after")).toBe("1");
      expect(((await blocked.json()) as ErrorEnvelope).error.code).toBe("TRANSIENT_FAILURE");
      expect(await transactionCount(wallet.id)).toBe(0);
      expect(await app.get(MetricsService).render()).toContain(
        'wallet_lock_conflicts_total{type="lock_timeout"}',
      );

      const retry = await post(body, headers);
      expect(retry.status).toBe(201);
      await assertLedgerMatchesBalance(wallet.id, db.orm.em);
    });
  });

  describe("Idempotency-Key header", () => {
    it("answers 400 MISSING_IDEMPOTENCY_KEY when the header is absent", async () => {
      const wallet = await createWallet("100.00");

      const response = await post(validBody(wallet));

      expect(response.status).toBe(400);
      const body = (await response.json()) as ErrorEnvelope;
      expect(body.error.code).toBe("MISSING_IDEMPOTENCY_KEY");
      expect(body.correlationId.length).toBeGreaterThan(0);
      expect(await transactionCount(wallet.id)).toBe(0);
    });

    it("answers 400 MISSING_IDEMPOTENCY_KEY when the header is blank", async () => {
      const wallet = await createWallet("100.00");

      const response = await post(validBody(wallet), { "Idempotency-Key": "   " });

      expect(response.status).toBe(400);
      expect(((await response.json()) as ErrorEnvelope).error.code).toBe("MISSING_IDEMPOTENCY_KEY");
    });

    it("answers 400 VALIDATION_ERROR above 255 characters and accepts exactly 255", async () => {
      const wallet = await createWallet("100.00");

      const tooLong = await post(validBody(wallet), { "Idempotency-Key": "k".repeat(256) });
      const limit = await post(validBody(wallet), { "Idempotency-Key": "k".repeat(255) });

      expect(tooLong.status).toBe(400);
      expect(((await tooLong.json()) as ErrorEnvelope).error.code).toBe("VALIDATION_ERROR");
      expect(limit.status).toBe(201);
    });
  });

  describe("payload validation", () => {
    const invalidPayloads: Array<[string, (w: { id: string; playerId: string }) => unknown]> = [
      ["OPENING kind", (w) => validBody(w, { kind: "OPENING" })],
      ["unknown kind", (w) => validBody(w, { kind: "TRANSFER" })],
      ["lowercase kind", (w) => validBody(w, { kind: "bet" })],
      ["REFUND without reference", (w) => validBody(w, { kind: "REFUND" })],
      ["ROLLBACK without reference", (w) => validBody(w, { kind: "ROLLBACK" })],
      ["zero BET", (w) => validBody(w, { money: { amount: "0.00", currency: "BRL" } })],
      ["zero WIN", (w) => validBody(w, { kind: "WIN", money: { amount: "0.00", currency: "BRL" } })],
      ["negative amount", (w) => validBody(w, { money: { amount: "-1.00", currency: "BRL" } })],
      ["amount without decimals", (w) => validBody(w, { money: { amount: "10", currency: "BRL" } })],
      ["numeric amount", (w) => validBody(w, { money: { amount: 10.5, currency: "BRL" } })],
      ["lowercase currency", (w) => validBody(w, { money: { amount: "1.00", currency: "brl" } })],
      ["missing money", (w) => validBody(w, { money: undefined })],
      ["walletId not a UUID", (w) => validBody(w, { walletId: "not-a-uuid" })],
      ["missing walletId", (w) => validBody(w, { walletId: undefined })],
      ["empty providerId", (w) => validBody(w, { providerId: "" })],
      ["blank playerId", (w) => validBody(w, { playerId: "  " })],
      ["numeric roundId", (w) => validBody(w, { roundId: 7 })],
      ["gameId over 128 characters", (w) => validBody(w, { gameId: "g".repeat(129) })],
      ["externalTransactionId over 255 characters", (w) => validBody(w, { externalTransactionId: "e".repeat(256) })],
      ["empty object", () => ({})],
      ["null body", () => null],
      ["array body", () => []],
    ];

    for (const [name, build] of invalidPayloads) {
      it(`answers 400 VALIDATION_ERROR for ${name} and stores nothing`, async () => {
        const wallet = await createWallet("100.00");

        const response = await post(build(wallet), { "Idempotency-Key": `invalid-${name}` });

        expect(response.status).toBe(400);
        const body = (await response.json()) as ErrorEnvelope;
        expect(body.error.code).toBe("VALIDATION_ERROR");
        expect(await transactionCount(wallet.id)).toBe(0);
      });
    }

    it("points the details at the offending fields", async () => {
      const wallet = await createWallet("100.00");

      const response = await post(validBody(wallet, { kind: "REFUND", money: { amount: "0.00", currency: "BRL" } }), {
        "Idempotency-Key": "details",
      });

      const body = (await response.json()) as ErrorEnvelope;
      expect(body.error.details?.map((issue) => issue.path).sort()).toEqual([
        "money",
        "referenceExternalTransactionId",
      ]);
    });

    it("answers 400 for malformed JSON", async () => {
      const response = await post("{ not json", { "Idempotency-Key": "malformed" });

      expect(response.status).toBe(400);
      expect(((await response.json()) as ErrorEnvelope).error.code).toBe("VALIDATION_ERROR");
    });
  });
});
