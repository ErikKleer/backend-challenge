import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { type FaultInjector, FaultPoint } from "../../../src/shared/application/fault-injector.port";
import { createTestDatabase, type TestDatabaseContext } from "../../support/database";
import { assertAllWalletsConsistent, assertNoStuckTransactions } from "../../support/invariants";
import { createPersistenceTestContext, type PersistenceTestContext } from "../../support/persistence";
import { brl, WageringHarness } from "../../support/wagering";

/** Falha em processo no ponto indicado: a mesma posição do `SIGKILL` dos testes multiprocesso. */
class ThrowingFaultInjector implements FaultInjector {
  public hits = 0;

  constructor(private readonly point: FaultPoint) {}

  public reach(point: FaultPoint): void {
    if (point === this.point) {
      this.hits += 1;
      throw new Error(`injected failure at ${point}`);
    }
  }
}

interface DatabaseState {
  wallets: Array<{ id: string; balance: string; version: number }>;
  ledgerEntries: number;
  transactions: number;
  inboxMessages: number;
  outboxMessages: number;
}

describe("financial transaction atomicity under an injected failure", () => {
  let db: TestDatabaseContext;
  let ctx: PersistenceTestContext;
  let harness: WageringHarness;

  beforeAll(async () => {
    db = await createTestDatabase();
    ctx = await createPersistenceTestContext(db);
    harness = new WageringHarness(ctx);
  });

  afterAll(async () => {
    await ctx.app.close();
    await db.teardown();
  });

  async function count(table: string): Promise<number> {
    const [row] = await db.orm.em.execute<Array<{ n: string }>>(`SELECT COUNT(*)::text AS n FROM ${table}`);
    return Number(row!.n);
  }

  /** Estado completo do banco: qualquer escrita que sobreviva à falha aparece na comparação. */
  async function snapshot(): Promise<DatabaseState> {
    return {
      wallets: await db.orm.em.execute<DatabaseState["wallets"]>(
        "SELECT id, balance::text AS balance, version FROM wallets ORDER BY id",
      ),
      ledgerEntries: await count("wallet_ledger_entries"),
      transactions: await count("wager_transactions"),
      inboxMessages: await count("inbox_messages"),
      outboxMessages: await count("outbox_messages"),
    };
  }

  const inbox = (messageId: string) => ({
    consumerName: "wager-transactions-consumer",
    messageId,
    payloadHash: "a".repeat(64),
  });

  it("after_ledger_before_commit leaves no wallet, ledger, transaction or outbox change (HTTP path)", async () => {
    const wallet = await harness.createWallet("100.00");
    const before = await snapshot();
    const faults = new ThrowingFaultInjector(FaultPoint.AfterLedgerBeforeCommit);
    const failing = new WageringHarness(ctx, { faults });
    const command = harness.command(wallet, { money: brl("30.00") });

    await expect(failing.useCase.execute(command)).rejects.toThrow("injected failure at after_ledger_before_commit");

    expect(faults.hits).toBe(1);
    expect(await snapshot()).toEqual(before);
    await assertAllWalletsConsistent(db.orm.em);

    // Sem a falha, a mesma requisição é a primeira: nada do estado parcial a atrapalha
    const retry = await harness.useCase.execute(command);
    expect(retry.idempotentReplay).toBe(false);
    expect(retry.balance.amount).toBe("70.00");
    await assertNoStuckTransactions(db.orm.em);
    await assertAllWalletsConsistent(db.orm.em);
  });

  it("after_ledger_before_commit also leaves no inbox row (SQS path)", async () => {
    const wallet = await harness.createWallet("100.00");
    const before = await snapshot();
    const faults = new ThrowingFaultInjector(FaultPoint.AfterLedgerBeforeCommit);
    const failing = new WageringHarness(ctx, { faults });
    const command = harness.command(wallet, { money: brl("45.00") });

    await expect(failing.useCase.execute(command, { inbox: inbox("msg-atomic") })).rejects.toThrow(
      "injected failure at after_ledger_before_commit",
    );

    expect(await snapshot()).toEqual(before);
    expect(await count("inbox_messages")).toBe(before.inboxMessages);
    await assertAllWalletsConsistent(db.orm.em);

    // A reentrega da mesma mensagem processa por inteiro: inbox, saldo, ledger e eventos juntos
    const retry = await harness.useCase.execute(command, { inbox: inbox("msg-atomic") });
    expect(retry.idempotentReplay).toBe(false);
    expect(retry.balance.amount).toBe("55.00");
    const after = await snapshot();
    expect(after.inboxMessages).toBe(before.inboxMessages + 1);
    expect(after.ledgerEntries).toBe(before.ledgerEntries + 1);
    expect(after.transactions).toBe(before.transactions + 1);
    expect(after.outboxMessages).toBe(before.outboxMessages + 2);
    await assertAllWalletsConsistent(db.orm.em);
  });

  it("a point that is never reached does not disturb the flow", async () => {
    const wallet = await harness.createWallet("100.00");
    const faults = new ThrowingFaultInjector(FaultPoint.AfterPublishBeforeCommit);
    const other = new WageringHarness(ctx, { faults });

    const result = await other.useCase.execute(other.command(wallet, { money: brl("10.00") }));

    expect(result.balance.amount).toBe("90.00");
    expect(faults.hits).toBe(0);
    await assertAllWalletsConsistent(db.orm.em);
  });
});
