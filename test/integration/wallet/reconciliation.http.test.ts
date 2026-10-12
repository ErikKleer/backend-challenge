import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Writable } from "node:stream";
import { Money } from "../../../src/shared/domain/money";
import { AppLogger } from "../../../src/shared/infrastructure/observability/app-logger";
import { MetricsService } from "../../../src/shared/infrastructure/observability/metrics.service";
import { ReconcileWalletUseCase } from "../../../src/wallet/application/reconcile-wallet.use-case";
import { MikroOrmReconciliationRepository } from "../../../src/wallet/infrastructure/persistence/reconciliation.repository";
import { createTestDatabase, type TestDatabaseContext } from "../../support/database";
import { startTestApi, type TestApi } from "../../support/http-app";

interface ReconciliationBody {
  walletId: string;
  storedBalance: { amount: string; currency: string };
  calculatedBalance: { amount: string; currency: string };
  difference: { amount: string; currency: string };
  consistent: boolean;
  checkedEntries: number;
}

describe("POST /wallets/:walletId/reconciliation", () => {
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
    const playerId = `recon-player-${sequence}`;
    const response = await fetch(`${api.baseUrl}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ playerId, initialBalance: { amount: balance, currency: "BRL" } }),
    });
    return { id: ((await response.json()) as { id: string }).id, playerId };
  }

  async function bet(wallet: { id: string; playerId: string }, amount: string): Promise<void> {
    sequence += 1;
    const externalTransactionId = `ext-recon-${sequence}`;
    await fetch(`${api.baseUrl}/wagering/transactions`, {
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
  }

  const reconcile = (walletId: string) =>
    fetch(`${api.baseUrl}/wallets/${walletId}/reconciliation`, { method: "POST" });

  it("reports a consistent wallet with the documented shape", async () => {
    const wallet = await createWallet("1000.00");
    await bet(wallet, "25.00");

    const response = await reconcile(wallet.id);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: "975.00", currency: "BRL" },
      calculatedBalance: { amount: "975.00", currency: "BRL" },
      difference: { amount: "0.00", currency: "BRL" },
      consistent: true,
      checkedEntries: 2,
    });
  });

  it("is consistent for a wallet opened with zero and no entries", async () => {
    const wallet = await createWallet("0.00");

    const body = (await (await reconcile(wallet.id)).json()) as ReconciliationBody;

    expect(body.consistent).toBe(true);
    expect(body.checkedEntries).toBe(0);
    expect(body.calculatedBalance.amount).toBe("0.00");
  });

  it("answers 404 for an unknown wallet and 400 for a malformed id", async () => {
    const unknown = await reconcile("0192f291-27dd-7d3f-8071-5f8685deef37");
    const malformed = await reconcile("nope");

    expect(unknown.status).toBe(404);
    expect(malformed.status).toBe(400);
  });

  it("flags a forced divergence without fixing it", async () => {
    const wallet = await createWallet("100.00");
    await bet(wallet, "30.00");
    // O ledger é imutável (triggers) e a wallet não tem trigger sobre `balance`; a
    // divergência é forçada por SQL direto alterando apenas `wallets.balance`.
    await db.orm.em.execute("UPDATE wallets SET balance = 80.00 WHERE id = ?", [wallet.id]);

    const response = await reconcile(wallet.id);
    const body = (await response.json()) as ReconciliationBody;

    expect(response.status).toBe(200);
    expect(body.consistent).toBe(false);
    expect(body.storedBalance.amount).toBe("80.00");
    expect(body.calculatedBalance.amount).toBe("70.00");
    expect(body.difference.amount).toBe("10.00");
    expect(body.checkedEntries).toBe(2);

    // Nada foi corrigido: a wallet continua com o valor adulterado.
    const [row] = await db.orm.em.execute<Array<{ balance: string }>>(
      "SELECT balance::text AS balance FROM wallets WHERE id = ?",
      [wallet.id],
    );
    expect(row?.balance).toBe("80.00");
  });

  it("reports a negative difference when the wallet is below the ledger", async () => {
    const wallet = await createWallet("100.00");
    await db.orm.em.execute("UPDATE wallets SET balance = 40.50 WHERE id = ?", [wallet.id]);

    const body = (await (await reconcile(wallet.id)).json()) as ReconciliationBody;

    expect(body.consistent).toBe(false);
    expect(body.difference.amount).toBe("-59.50");
  });

  it("counts the divergence in the metric and logs it as an error", async () => {
    const lines: string[] = [];
    const destination = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const metrics = new MetricsService({ collectDefaults: false });
    const useCase = new ReconcileWalletUseCase(
      new MikroOrmReconciliationRepository(db.orm.em),
      new AppLogger({ level: "info", destination }),
      metrics,
    );
    const consistent = await createWallet("10.00");
    const divergent = await createWallet("10.00");
    await db.orm.em.execute("UPDATE wallets SET balance = 11.00 WHERE id = ?", [divergent.id]);

    const ok = await useCase.execute(consistent.id);
    expect(ok.consistent).toBe(true);
    expect(await metrics.render()).toMatch(/reconciliation_divergences_total 0/);
    expect(lines).toHaveLength(0);

    const bad = await useCase.execute(divergent.id);

    expect(bad.consistent).toBe(false);
    expect(bad.difference.equals(Money.from({ amount: "1.00", currency: "BRL" }))).toBe(true);
    expect(await metrics.render()).toMatch(/reconciliation_divergences_total 1/);
    expect(lines).toHaveLength(1);
    const log = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(log.level).toBe("error");
    expect(log.walletId).toBe(divergent.id);
    expect(log.divergence).toBe("stored_above_ledger");
    expect(lines[0]).not.toContain("11.00");
  });
});
