import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createTestDatabase, type TestDatabaseContext } from "../../support/database";

describe("Database Schema: Wallets and WagerTransactions Constraints & Triggers", () => {
  let db: TestDatabaseContext;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db.teardown();
  });

  describe("wallets table constraints", () => {
    it("should reject duplicate wallet for the same player_id and currency", async () => {
      const wId1 = "11111111-1111-1111-1111-111111111111";
      const wId2 = "22222222-2222-2222-2222-222222222222";
      const playerId = "player-unique-test";
      const now = new Date();

      await db.orm.em.execute(
        `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [wId1, playerId, "BRL", "100.00", 1, now, now],
      );

      let error: any;
      try {
        await db.orm.em.execute(
          `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [wId2, playerId, "BRL", "50.00", 1, now, now],
        );
      } catch (err) {
        error = err;
      }

      expect(error).toBeDefined();
      expect(String(error.message)).toMatch(/uq_wallets_player_currency|unique constraint/i);
    });

    it("should reject negative balance via CHECK constraint", async () => {
      const wId = "33333333-3333-3333-3333-333333333333";
      const now = new Date();

      let error: any;
      try {
        await db.orm.em.execute(
          `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [wId, "player-neg-balance", "BRL", "-0.01", 1, now, now],
        );
      } catch (err) {
        error = err;
      }

      expect(error).toBeDefined();
      expect(String(error.message)).toMatch(/chk_wallets_balance_non_negative|check constraint/i);
    });

    it("should reject invalid wallet version (< 1) via CHECK constraint", async () => {
      const wId = "44444444-4444-4444-4444-444444444444";
      const now = new Date();

      let error: any;
      try {
        await db.orm.em.execute(
          `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [wId, "player-invalid-version", "BRL", "10.00", 0, now, now],
        );
      } catch (err) {
        error = err;
      }

      expect(error).toBeDefined();
      expect(String(error.message)).toMatch(/chk_wallets_version_positive|check constraint/i);
    });

    it("should reject invalid currency format via CHECK constraint", async () => {
      const wId = "55555555-5555-5555-5555-555555555555";
      const now = new Date();

      let error: any;
      try {
        await db.orm.em.execute(
          `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [wId, "player-bad-cur", "brl", "10.00", 1, now, now],
        );
      } catch (err) {
        error = err;
      }

      expect(error).toBeDefined();
      expect(String(error.message)).toMatch(/chk_wallets_currency_format|check constraint/i);
    });
  });

  describe("wager_transactions table constraints and triggers", () => {
    const defaultWalletId = "66666666-6666-6666-6666-666666666666";

    beforeAll(async () => {
      const now = new Date();
      await db.orm.em.execute(
        `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [defaultWalletId, "player-for-tx", "BRL", "500.00", 1, now, now],
      );
    });

    it("should reject duplicate transaction by idempotency_key", async () => {
      const tx1 = "77777777-7777-7777-7777-777777777771";
      const tx2 = "77777777-7777-7777-7777-777777777772";
      const idemKey = "idem-key-duplicate-test";
      const now = new Date();

      await db.orm.em.execute(
        `INSERT INTO wager_transactions (
          id, provider_id, external_transaction_id, idempotency_key, payload_hash,
          wallet_id, player_id, round_id, game_id, kind, status, amount, currency,
          reference_attempts, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          tx1, "provider-a", "ext-1", idemKey, "a".repeat(64),
          defaultWalletId, "player-for-tx", "round-1", "game-1", "BET", "PENDING",
          "50.00", "BRL", 0, now, now,
        ],
      );

      let error: any;
      try {
        await db.orm.em.execute(
          `INSERT INTO wager_transactions (
            id, provider_id, external_transaction_id, idempotency_key, payload_hash,
            wallet_id, player_id, round_id, game_id, kind, status, amount, currency,
            reference_attempts, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            tx2, "provider-a", "ext-2", idemKey, "b".repeat(64),
            defaultWalletId, "player-for-tx", "round-1", "game-1", "BET", "PENDING",
            "50.00", "BRL", 0, now, now,
          ],
        );
      } catch (err) {
        error = err;
      }

      expect(error).toBeDefined();
      expect(String(error.message)).toMatch(/uq_wager_transactions_idempotency_key|unique constraint/i);
    });

    it("should reject duplicate transaction by (provider_id, external_transaction_id)", async () => {
      const tx1 = "88888888-8888-8888-8888-888888888881";
      const tx2 = "88888888-8888-8888-8888-888888888882";
      const extId = "ext-duplicate-provider-test";
      const now = new Date();

      await db.orm.em.execute(
        `INSERT INTO wager_transactions (
          id, provider_id, external_transaction_id, idempotency_key, payload_hash,
          wallet_id, player_id, round_id, game_id, kind, status, amount, currency,
          reference_attempts, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          tx1, "provider-b", extId, "idem-1", "a".repeat(64),
          defaultWalletId, "player-for-tx", "round-1", "game-1", "BET", "PENDING",
          "50.00", "BRL", 0, now, now,
        ],
      );

      let error: any;
      try {
        await db.orm.em.execute(
          `INSERT INTO wager_transactions (
            id, provider_id, external_transaction_id, idempotency_key, payload_hash,
            wallet_id, player_id, round_id, game_id, kind, status, amount, currency,
            reference_attempts, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            tx2, "provider-b", extId, "idem-2", "b".repeat(64),
            defaultWalletId, "player-for-tx", "round-1", "game-1", "BET", "PENDING",
            "50.00", "BRL", 0, now, now,
          ],
        );
      } catch (err) {
        error = err;
      }

      expect(error).toBeDefined();
      expect(String(error.message)).toMatch(/uq_wager_transactions_provider_external_id|unique constraint/i);
    });
    it("should enforce partial unique index for processed reversals", async () => {
      const betTxId = "99999999-9999-9999-9999-999999999990";
      const refundTxId1 = "99999999-9999-9999-9999-999999999991";
      const refundTxId2 = "99999999-9999-9999-9999-999999999992";
      const now = new Date();

      await db.orm.em.execute(
        `INSERT INTO wager_transactions (
          id, provider_id, external_transaction_id, idempotency_key, payload_hash,
          wallet_id, player_id, round_id, game_id, kind, status, amount, currency,
          reference_attempts, created_at, processed_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          betTxId, "provider-rev", "bet-ext-1", "idem-bet-rev", "a".repeat(64),
          defaultWalletId, "player-for-tx", "round-1", "game-1", "BET", "PROCESSED",
          "100.00", "BRL", 0, now, now, now,
        ],
      );

      await db.orm.em.execute(
        `INSERT INTO wager_transactions (
          id, provider_id, external_transaction_id, idempotency_key, payload_hash,
          wallet_id, player_id, round_id, game_id, kind, status, amount, currency,
          reference_external_transaction_id, reference_transaction_id,
          reference_attempts, created_at, processed_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          refundTxId1, "provider-rev", "ref-ext-1", "idem-ref-1", "b".repeat(64),
          defaultWalletId, "player-for-tx", "round-1", "game-1", "REFUND", "PROCESSED",
          "100.00", "BRL", "bet-ext-1", betTxId, 0, now, now, now,
        ],
      );

      let error: any;
      try {
        await db.orm.em.execute(
          `INSERT INTO wager_transactions (
            id, provider_id, external_transaction_id, idempotency_key, payload_hash,
            wallet_id, player_id, round_id, game_id, kind, status, amount, currency,
            reference_external_transaction_id, reference_transaction_id,
            reference_attempts, created_at, processed_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            refundTxId2, "provider-rev", "ref-ext-2", "idem-ref-2", "c".repeat(64),
            defaultWalletId, "player-for-tx", "round-1", "game-1", "ROLLBACK", "PROCESSED",
            "100.00", "BRL", "bet-ext-1", betTxId, 0, now, now, now,
          ],
        );
      } catch (err) {
        error = err;
      }

      expect(error).toBeDefined();
      expect(String(error.message)).toMatch(/uq_idx_wager_transactions_processed_reversal|unique constraint/i);
    });

    it("should prevent UPDATE when transaction is in terminal status via trigger", async () => {
      const termTxId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
      const now = new Date();

      await db.orm.em.execute(
        `INSERT INTO wager_transactions (
          id, provider_id, external_transaction_id, idempotency_key, payload_hash,
          wallet_id, player_id, round_id, game_id, kind, status, amount, currency,
          reference_attempts, created_at, processed_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          termTxId, "provider-term", "ext-term-1", "idem-term-1", "d".repeat(64),
          defaultWalletId, "player-for-tx", "round-1", "game-1", "BET", "PROCESSED",
          "100.00", "BRL", 0, now, now, now,
        ],
      );

      let error: any;
      try {
        await db.orm.em.execute(
          `UPDATE wager_transactions SET updated_at = NOW() WHERE id = ?`,
          [termTxId],
        );
      } catch (err) {
        error = err;
      }

      expect(error).toBeDefined();
      expect(String(error.message)).toMatch(/Cannot update transaction in terminal status/i);
    });

    it("should prevent updating identity columns on non-terminal transaction via trigger", async () => {
      const pendTxId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
      const now = new Date();

      await db.orm.em.execute(
        `INSERT INTO wager_transactions (
          id, provider_id, external_transaction_id, idempotency_key, payload_hash,
          wallet_id, player_id, round_id, game_id, kind, status, amount, currency,
          reference_attempts, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          pendTxId, "provider-ident", "ext-ident-1", "idem-ident-1", "e".repeat(64),
          defaultWalletId, "player-for-tx", "round-1", "game-1", "BET", "PENDING",
          "100.00", "BRL", 0, now, now,
        ],
      );

      let error: any;
      try {
        await db.orm.em.execute(
          `UPDATE wager_transactions SET amount = 200.00 WHERE id = ?`,
          [pendTxId],
        );
      } catch (err) {
        error = err;
      }

      expect(error).toBeDefined();
      expect(String(error.message)).toMatch(/Cannot mutate immutable identity columns/i);
    });

    it("should prevent DELETE of wager_transactions via audit trigger", async () => {
      const delTxId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
      const now = new Date();

      await db.orm.em.execute(
        `INSERT INTO wager_transactions (
          id, provider_id, external_transaction_id, idempotency_key, payload_hash,
          wallet_id, player_id, round_id, game_id, kind, status, amount, currency,
          reference_attempts, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          delTxId, "provider-del", "ext-del-1", "idem-del-1", "f".repeat(64),
          defaultWalletId, "player-for-tx", "round-1", "game-1", "BET", "PENDING",
          "10.00", "BRL", 0, now, now,
        ],
      );

      let error: any;
      try {
        await db.orm.em.execute(`DELETE FROM wager_transactions WHERE id = ?`, [delTxId]);
      } catch (err) {
        error = err;
      }

      expect(error).toBeDefined();
      expect(String(error.message)).toMatch(/strictly prohibited for financial auditing/i);
    });
  });
});


