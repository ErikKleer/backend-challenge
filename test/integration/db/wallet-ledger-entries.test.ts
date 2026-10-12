import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createTestDatabase, type TestDatabaseContext } from "../../support/database";

describe("Database Schema: wallet_ledger_entries Append-Only and Integrity", () => {
  let db: TestDatabaseContext;
  const walletId = "10000000-0000-0000-0000-000000000001";
  const txId1 = "20000000-0000-0000-0000-000000000001";
  const txId2 = "20000000-0000-0000-0000-000000000002";

  beforeAll(async () => {
    db = await createTestDatabase();
    const now = new Date();

    await db.orm.em.execute(
      `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [walletId, "player-ledger-test", "BRL", "200.00", 1, now, now],
    );

    await db.orm.em.execute(
      `INSERT INTO wager_transactions (
        id, provider_id, external_transaction_id, idempotency_key, payload_hash,
        wallet_id, player_id, round_id, game_id, kind, status, amount, currency,
        reference_attempts, created_at, processed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        txId1, "p-ledger", "ext-tx-1", "idem-tx-1", "a".repeat(64),
        walletId, "player-ledger-test", "r-1", "g-1", "BET", "PROCESSED",
        "50.00", "BRL", 0, now, now, now,
      ],
    );

    await db.orm.em.execute(
      `INSERT INTO wager_transactions (
        id, provider_id, external_transaction_id, idempotency_key, payload_hash,
        wallet_id, player_id, round_id, game_id, kind, status, amount, currency,
        reference_attempts, created_at, processed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        txId2, "p-ledger", "ext-tx-2", "idem-tx-2", "b".repeat(64),
        walletId, "player-ledger-test", "r-1", "g-1", "WIN", "PROCESSED",
        "30.00", "BRL", 0, now, now, now,
      ],
    );
  });

  afterAll(async () => {
    await db.teardown();
  });

  it("should accept valid balanced CREDIT and DEBIT entries", async () => {
    const entryId1 = "30000000-0000-0000-0000-000000000001";
    const entryId2 = "30000000-0000-0000-0000-000000000002";
    const now = new Date();

    await db.orm.em.execute(
      `INSERT INTO wallet_ledger_entries (
        id, wallet_id, transaction_id, direction, amount, currency,
        balance_before, balance_after, wallet_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [entryId1, walletId, txId1, "DEBIT", "50.00", "BRL", "200.00", "150.00", 2, now],
    );

    await db.orm.em.execute(
      `INSERT INTO wallet_ledger_entries (
        id, wallet_id, transaction_id, direction, amount, currency,
        balance_before, balance_after, wallet_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [entryId2, walletId, txId2, "CREDIT", "30.00", "BRL", "150.00", "180.00", 3, now],
    );

    const rows = await db.orm.em.execute(
      `SELECT count(*)::int as count FROM wallet_ledger_entries WHERE wallet_id = ?`,
      [walletId],
    );
    expect(rows[0]!.count).toBe(2);
  });

  it("should reject ledger entry with wrong arithmetic", async () => {
    const badEntryId = "40000000-0000-0000-0000-000000000001";
    const now = new Date();

    let error: any;
    try {
      await db.orm.em.execute(
        `INSERT INTO wallet_ledger_entries (
          id, wallet_id, transaction_id, direction, amount, currency,
          balance_before, balance_after, wallet_version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [badEntryId, walletId, txId1, "DEBIT", "50.00", "BRL", "100.00", "60.00", 10, now],
      );
    } catch (err) {
      error = err;
    }

    expect(error).toBeDefined();
    expect(String(error.message)).toMatch(/chk_wallet_ledger_entries_arithmetic|check constraint/i);
  });

  it("should reject second ledger entry for the same (transaction_id, wallet_id)", async () => {
    const dupTxEntryId = "50000000-0000-0000-0000-000000000001";
    const now = new Date();

    let error: any;
    try {
      await db.orm.em.execute(
        `INSERT INTO wallet_ledger_entries (
          id, wallet_id, transaction_id, direction, amount, currency,
          balance_before, balance_after, wallet_version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [dupTxEntryId, walletId, txId1, "DEBIT", "50.00", "BRL", "200.00", "150.00", 20, now],
      );
    } catch (err) {
      error = err;
    }

    expect(error).toBeDefined();
    expect(String(error.message)).toMatch(/uq_wallet_ledger_entries_tx_wallet|unique constraint/i);
  });

  it("should reject duplicate wallet_version for the same wallet_id", async () => {
    const dupVerEntryId = "60000000-0000-0000-0000-000000000001";
    const newTxId = "20000000-0000-0000-0000-000000000003";
    const now = new Date();

    await db.orm.em.execute(
      `INSERT INTO wager_transactions (
        id, provider_id, external_transaction_id, idempotency_key, payload_hash,
        wallet_id, player_id, round_id, game_id, kind, status, amount, currency,
        reference_attempts, created_at, processed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newTxId, "p-ledger", "ext-tx-3", "idem-tx-3", "c".repeat(64),
        walletId, "player-ledger-test", "r-1", "g-1", "BET", "PROCESSED",
        "10.00", "BRL", 0, now, now, now,
      ],
    );

    let error: any;
    try {
      await db.orm.em.execute(
        `INSERT INTO wallet_ledger_entries (
          id, wallet_id, transaction_id, direction, amount, currency,
          balance_before, balance_after, wallet_version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [dupVerEntryId, walletId, newTxId, "DEBIT", "10.00", "BRL", "100.00", "90.00", 2, now],
      );
    } catch (err) {
      error = err;
    }

    expect(error).toBeDefined();
    expect(String(error.message)).toMatch(/uq_wallet_ledger_entries_wallet_version|unique constraint/i);
  });

  it("should prevent UPDATE on wallet_ledger_entries via trigger", async () => {
    let error: any;
    try {
      await db.orm.em.execute(
        `UPDATE wallet_ledger_entries SET amount = 999.00 WHERE id = ?`,
        ["30000000-0000-0000-0000-000000000001"],
      );
    } catch (err) {
      error = err;
    }

    expect(error).toBeDefined();
    expect(String(error.message)).toMatch(/append-only/i);
  });

  it("should prevent DELETE on wallet_ledger_entries via trigger", async () => {
    let error: any;
    try {
      await db.orm.em.execute(
        `DELETE FROM wallet_ledger_entries WHERE id = ?`,
        ["30000000-0000-0000-0000-000000000001"],
      );
    } catch (err) {
      error = err;
    }

    expect(error).toBeDefined();
    expect(String(error.message)).toMatch(/append-only/i);
  });

  it("should prevent TRUNCATE on wallet_ledger_entries via statement trigger", async () => {
    let error: any;
    try {
      await db.orm.em.execute(`TRUNCATE TABLE wallet_ledger_entries`);
    } catch (err) {
      error = err;
    }

    expect(error).toBeDefined();
    expect(String(error.message)).toMatch(/Truncating wallet ledger entries is strictly prohibited/i);
  });
});
