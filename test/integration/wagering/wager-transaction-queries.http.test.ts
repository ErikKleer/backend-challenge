import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createTestDatabase, type TestDatabaseContext } from "../../support/database";
import { startTestApi, type TestApi } from "../../support/http-app";

interface ErrorEnvelope {
  error: { code: string; details?: Array<{ path: string }> };
  correlationId: string;
}

interface SubmitBody {
  transactionId: string;
  status: string;
}

describe("wager transaction queries", () => {
  let db: TestDatabaseContext;
  let api: TestApi;
  let sequence = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    api = await startTestApi(db);
  });

  afterAll(async () => {
    await api.close();
    await db.teardown();
  });

  async function createWallet(balance: string): Promise<{ id: string; playerId: string }> {
    sequence += 1;
    const playerId = `tx-query-player-${sequence}`;
    const response = await fetch(`${api.baseUrl}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ playerId, initialBalance: { amount: balance, currency: "BRL" } }),
    });
    return { id: ((await response.json()) as { id: string }).id, playerId };
  }

  async function submit(
    wallet: { id: string; playerId: string },
    fields: Record<string, unknown>,
  ): Promise<{ externalTransactionId: string; body: SubmitBody }> {
    sequence += 1;
    const externalTransactionId = `ext-tx-query-${sequence}`;
    const response = await fetch(`${api.baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": `provider-q:${externalTransactionId}`,
      },
      body: JSON.stringify({
        providerId: "provider-q",
        externalTransactionId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: "round-q",
        gameId: "game-q",
        kind: "BET",
        money: { amount: "25.00", currency: "BRL" },
        ...fields,
      }),
    });
    return { externalTransactionId, body: (await response.json()) as SubmitBody };
  }

  const get = (path: string) => fetch(`${api.baseUrl}${path}`);

  it("returns the transaction view by id, with the observed balance", async () => {
    const wallet = await createWallet("100.00");
    const { externalTransactionId, body } = await submit(wallet, {});

    const response = await get(`/wagering/transactions/${body.transactionId}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      transactionId: body.transactionId,
      providerId: "provider-q",
      externalTransactionId,
      status: "PROCESSED",
      kind: "BET",
      money: { amount: "25.00", currency: "BRL" },
      walletId: wallet.id,
      roundId: "round-q",
      balance: { amount: "75.00", currency: "BRL" },
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
      processedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
    });
  });

  it("returns the same view by provider and external transaction id", async () => {
    const wallet = await createWallet("100.00");
    const { externalTransactionId, body } = await submit(wallet, {});

    const byProvider = await get(
      `/providers/provider-q/wagering/transactions/${externalTransactionId}`,
    );
    const byId = await get(`/wagering/transactions/${body.transactionId}`);

    expect(byProvider.status).toBe(200);
    expect(await byProvider.json()).toEqual(await byId.json());
  });

  it("exposes failureCode and keeps the balance observed at rejection time", async () => {
    const wallet = await createWallet("10.00");
    const { body } = await submit(wallet, {});
    expect(body.status).toBe("REJECTED");

    const view = (await (await get(`/wagering/transactions/${body.transactionId}`)).json()) as Record<
      string,
      unknown
    >;

    expect(view.status).toBe("REJECTED");
    expect(view.failureCode).toBe("INSUFFICIENT_FUNDS");
    expect(view.balance).toEqual({ amount: "10.00", currency: "BRL" });
  });

  it("exposes referenceTransactionId on a settled reversal", async () => {
    const wallet = await createWallet("100.00");
    const bet = await submit(wallet, {});
    const refund = await submit(wallet, {
      kind: "REFUND",
      referenceExternalTransactionId: bet.externalTransactionId,
    });

    const view = (await (
      await get(`/wagering/transactions/${refund.body.transactionId}`)
    ).json()) as Record<string, unknown>;

    expect(view.kind).toBe("REFUND");
    expect(view.status).toBe("PROCESSED");
    expect(view.referenceTransactionId).toBe(bet.body.transactionId);
  });

  it("answers 404 TRANSACTION_NOT_FOUND for unknown ids", async () => {
    const byId = await get("/wagering/transactions/0192f291-27dd-7d3f-8071-5f8685deef37");
    const byProvider = await get("/providers/provider-q/wagering/transactions/missing");

    expect(byId.status).toBe(404);
    expect(((await byId.json()) as ErrorEnvelope).error.code).toBe("TRANSACTION_NOT_FOUND");
    expect(byProvider.status).toBe(404);
    expect(((await byProvider.json()) as ErrorEnvelope).error.code).toBe("TRANSACTION_NOT_FOUND");
  });

  it("answers 400 for a malformed transaction id", async () => {
    const response = await get("/wagering/transactions/not-a-uuid");

    expect(response.status).toBe(400);
    const body = (await response.json()) as ErrorEnvelope;
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.details?.[0]?.path).toBe("transactionId");
  });

  it("answers 400 for an oversized external transaction id", async () => {
    const response = await get(`/providers/provider-q/wagering/transactions/${"x".repeat(256)}`);

    expect(response.status).toBe(400);
    expect(((await response.json()) as ErrorEnvelope).error.code).toBe("VALIDATION_ERROR");
  });
});
