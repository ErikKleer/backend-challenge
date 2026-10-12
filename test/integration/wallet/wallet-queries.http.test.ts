import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createTestDatabase, type TestDatabaseContext } from "../../support/database";
import { startTestApi, type TestApi } from "../../support/http-app";

interface ErrorEnvelope {
  error: { code: string; details?: Array<{ path: string }> };
  correlationId: string;
}

interface LedgerBody {
  items: Array<{
    id: string;
    transactionId: string;
    direction: string;
    money: { amount: string; currency: string };
    balanceBefore: { amount: string; currency: string };
    balanceAfter: { amount: string; currency: string };
    walletVersion: number;
    createdAt: string;
  }>;
  nextCursor: string | null;
}

describe("wallet queries", () => {
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
    const playerId = `query-player-${sequence}`;
    const response = await fetch(`${api.baseUrl}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ playerId, initialBalance: { amount: balance, currency: "BRL" } }),
    });
    return { id: ((await response.json()) as { id: string }).id, playerId };
  }

  async function bet(wallet: { id: string; playerId: string }, amount: string): Promise<void> {
    sequence += 1;
    const externalTransactionId = `ext-query-${sequence}`;
    const response = await fetch(`${api.baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": `p:${externalTransactionId}` },
      body: JSON.stringify({
        providerId: "p",
        externalTransactionId,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: "r",
        gameId: "g",
        kind: "BET",
        money: { amount, currency: "BRL" },
      }),
    });
    expect(response.status).toBe(201);
  }

  const get = (path: string) => fetch(`${api.baseUrl}${path}`);

  describe("GET /wallets/:walletId", () => {
    it("returns id, playerId, balance and version", async () => {
      const wallet = await createWallet("100.00");
      await bet(wallet, "30.00");

      const response = await get(`/wallets/${wallet.id}`);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        id: wallet.id,
        playerId: wallet.playerId,
        balance: { amount: "70.00", currency: "BRL" },
        version: 2,
      });
    });

    it("answers 404 WALLET_NOT_FOUND for an unknown wallet", async () => {
      const response = await get("/wallets/0192f291-27dd-7d3f-8071-5f8685deef37");

      expect(response.status).toBe(404);
      expect(((await response.json()) as ErrorEnvelope).error.code).toBe("WALLET_NOT_FOUND");
    });

    it("answers 400 for a malformed id", async () => {
      const response = await get("/wallets/not-a-uuid");

      expect(response.status).toBe(400);
      const body = (await response.json()) as ErrorEnvelope;
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.details?.[0]?.path).toBe("walletId");
    });
  });

  describe("GET /wallets/:walletId/ledger", () => {
    it("lists entries by ascending wallet version with the documented item shape", async () => {
      const wallet = await createWallet("100.00");
      await bet(wallet, "30.00");

      const response = await get(`/wallets/${wallet.id}/ledger`);

      expect(response.status).toBe(200);
      const body = (await response.json()) as LedgerBody;
      expect(body.nextCursor).toBeNull();
      expect(body.items.map((item) => item.walletVersion)).toEqual([1, 2]);
      expect(body.items[1]).toEqual({
        id: expect.any(String),
        transactionId: expect.any(String),
        direction: "DEBIT",
        money: { amount: "30.00", currency: "BRL" },
        balanceBefore: { amount: "100.00", currency: "BRL" },
        balanceAfter: { amount: "70.00", currency: "BRL" },
        walletVersion: 2,
        createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
      });
    });

    it("paginates without gaps or repeats and ends with a null cursor", async () => {
      const wallet = await createWallet("100.00");
      for (let i = 0; i < 4; i += 1) {
        await bet(wallet, "1.00");
      }

      const seen: number[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const query: string = cursor ? `?limit=2&cursor=${cursor}` : "?limit=2";
        const page = (await (await get(`/wallets/${wallet.id}/ledger${query}`)).json()) as LedgerBody;
        seen.push(...page.items.map((item) => item.walletVersion));
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor !== null);

      expect(seen).toEqual([1, 2, 3, 4, 5]);
      expect(pages).toBe(3);
    });

    it("keeps an old cursor valid when new entries are appended", async () => {
      const wallet = await createWallet("100.00");
      await bet(wallet, "1.00");
      const first = (await (await get(`/wallets/${wallet.id}/ledger?limit=1`)).json()) as LedgerBody;
      expect(first.nextCursor).not.toBeNull();

      await bet(wallet, "1.00");
      const second = (await (
        await get(`/wallets/${wallet.id}/ledger?limit=10&cursor=${first.nextCursor}`)
      ).json()) as LedgerBody;

      expect(second.items.map((item) => item.walletVersion)).toEqual([2, 3]);
    });

    it("returns an empty page with a null cursor for a wallet without entries", async () => {
      const wallet = await createWallet("0.00");

      const body = (await (await get(`/wallets/${wallet.id}/ledger`)).json()) as LedgerBody;

      expect(body).toEqual({ items: [], nextCursor: null });
    });

    it.each(["cursor=garbage", "limit=0", "limit=201", "limit=abc"])(
      "answers 400 for %s",
      async (query) => {
        const wallet = await createWallet("10.00");

        const response = await get(`/wallets/${wallet.id}/ledger?${query}`);

        expect(response.status).toBe(400);
        expect(((await response.json()) as ErrorEnvelope).error.code).toBe("VALIDATION_ERROR");
      },
    );

    it("answers 404 for an unknown wallet", async () => {
      const response = await get("/wallets/0192f291-27dd-7d3f-8071-5f8685deef37/ledger");

      expect(response.status).toBe(404);
    });
  });
});
