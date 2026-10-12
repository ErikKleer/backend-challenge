import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { type INestApplication, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ApiModule } from "../../../src/app.module";
import { ObservabilityModule } from "../../../src/shared/infrastructure/observability/observability.module";
import { PersistenceModule } from "../../../src/shared/infrastructure/persistence/persistence.module";
import { createTestDatabase, type TestDatabaseContext } from "../../support/database";
import { assertLedgerMatchesBalance } from "../../support/invariants";

interface ErrorEnvelope {
  error: { code: string; message: string; details?: Array<{ path: string; message: string }> };
  correlationId: string;
}

describe("POST /wallets", () => {
  let db: TestDatabaseContext;
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    db = await createTestDatabase();

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
  });

  afterAll(async () => {
    await app.close();
    await db.teardown();
  });

  function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${baseUrl}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  it("creates the wallet and answers 201 with the exact documented shape", async () => {
    const response = await post({
      playerId: "http-player-1",
      initialBalance: { amount: "1000.00", currency: "BRL" },
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown> & { id: string };
    expect(body).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/),
      playerId: "http-player-1",
      balance: { amount: "1000.00", currency: "BRL" },
      version: 1,
    });
    expect(Object.keys(body).sort()).toEqual(["balance", "id", "playerId", "version"]);

    await assertLedgerMatchesBalance(body.id, db.orm.em);
    const [row] = await db.orm.em.execute<Array<Record<string, string>>>(
      `SELECT (SELECT COUNT(*) FROM wager_transactions WHERE wallet_id = ? AND kind = 'OPENING' AND status = 'PROCESSED') AS txs,
              (SELECT COUNT(*) FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'CREDIT') AS entries,
              (SELECT COUNT(*) FROM outbox_messages WHERE aggregate_id = ?) AS events`,
      [body.id, body.id, body.id],
    );
    expect(row).toEqual({ txs: "1", entries: "1", events: "2" });
  });

  it("accepts a zero initial balance", async () => {
    const response = await post({
      playerId: "http-player-zero",
      initialBalance: { amount: "0.00", currency: "BRL" },
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { id: string; balance: unknown; version: number };
    expect(body.balance).toEqual({ amount: "0.00", currency: "BRL" });
    expect(body.version).toBe(1);
  });

  it("answers 409 WALLET_ALREADY_EXISTS for a duplicate (playerId, currency)", async () => {
    const payload = {
      playerId: "http-player-dup",
      initialBalance: { amount: "10.00", currency: "BRL" },
    };
    expect((await post(payload)).status).toBe(201);

    const response = await post(payload);

    expect(response.status).toBe(409);
    const body = (await response.json()) as ErrorEnvelope;
    expect(body.error.code).toBe("WALLET_ALREADY_EXISTS");
    expect(body.correlationId).toBe(response.headers.get("x-correlation-id") ?? "");
  });

  const invalidBodies: Array<[string, unknown]> = [
    ["negative balance", { playerId: "p", initialBalance: { amount: "-1.00", currency: "BRL" } }],
    ['"10" without decimals', { playerId: "p", initialBalance: { amount: "10", currency: "BRL" } }],
    ['"10.5" with one decimal', { playerId: "p", initialBalance: { amount: "10.5", currency: "BRL" } }],
    ['"1e3" scientific notation', { playerId: "p", initialBalance: { amount: "1e3", currency: "BRL" } }],
    ['"NaN"', { playerId: "p", initialBalance: { amount: "NaN", currency: "BRL" } }],
    ["numeric amount", { playerId: "p", initialBalance: { amount: 10.5, currency: "BRL" } }],
    ["lowercase currency", { playerId: "p", initialBalance: { amount: "1.00", currency: "brl" } }],
    ["invalid currency", { playerId: "p", initialBalance: { amount: "1.00", currency: "REAL" } }],
    ["missing currency", { playerId: "p", initialBalance: { amount: "1.00" } }],
    ["missing balance", { playerId: "p" }],
    ["missing playerId", { initialBalance: { amount: "1.00", currency: "BRL" } }],
    ["empty playerId", { playerId: "", initialBalance: { amount: "1.00", currency: "BRL" } }],
    ["numeric playerId", { playerId: 7, initialBalance: { amount: "1.00", currency: "BRL" } }],
    [
      "playerId over 128 characters",
      { playerId: "x".repeat(129), initialBalance: { amount: "1.00", currency: "BRL" } },
    ],
    ["empty object", {}],
    ["null body", null],
    ["array body", []],
  ];
  for (const [name, payload] of invalidBodies) {
    it(`answers 400 VALIDATION_ERROR for ${name}`, async () => {
      const response = await post(payload);

      expect(response.status).toBe(400);
      const body = (await response.json()) as ErrorEnvelope;
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message.length).toBeGreaterThan(0);
      expect(body.correlationId.length).toBeGreaterThan(0);
    });
  }

  it("answers 400 VALIDATION_ERROR for an empty body", async () => {
    const response = await fetch(`${baseUrl}/wallets`, { method: "POST" });

    expect(response.status).toBe(400);
    expect(((await response.json()) as ErrorEnvelope).error.code).toBe("VALIDATION_ERROR");
  });

  it("points the error details at the offending field", async () => {
    const response = await post({
      playerId: "p",
      initialBalance: { amount: "10.5", currency: "BRL" },
    });

    const body = (await response.json()) as ErrorEnvelope;
    expect(body.error.details).toEqual([
      { path: "initialBalance", message: expect.stringContaining("2 decimal places") },
    ]);
  });

  it("creates nothing for rejected requests", async () => {
    const before = await db.orm.em.execute<Array<{ n: string }>>(
      "SELECT COUNT(*) AS n FROM wallets WHERE player_id = ?",
      ["http-player-invalid"],
    );
    await post({ playerId: "http-player-invalid", initialBalance: { amount: "-5.00", currency: "BRL" } });

    const after = await db.orm.em.execute<Array<{ n: string }>>(
      "SELECT COUNT(*) AS n FROM wallets WHERE player_id = ?",
      ["http-player-invalid"],
    );
    expect(after).toEqual(before);
  });

  it("echoes a valid incoming X-Correlation-Id on success and on error", async () => {
    const ok = await post(
      { playerId: "http-player-corr", initialBalance: { amount: "1.00", currency: "BRL" } },
      { "X-Correlation-Id": "trace-abc" },
    );
    const bad = await post({}, { "X-Correlation-Id": "trace-def" });

    expect(ok.headers.get("x-correlation-id")).toBe("trace-abc");
    expect(((await bad.json()) as ErrorEnvelope).correlationId).toBe("trace-def");
  });
});
