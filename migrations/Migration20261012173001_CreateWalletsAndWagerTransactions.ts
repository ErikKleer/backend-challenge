import { Migration } from "@mikro-orm/migrations";

export class Migration20261012173001_CreateWalletsAndWagerTransactions extends Migration {
  override async up(): Promise<void> {
    this.createWalletsTable();
    this.createWagerTransactionsTable();
    this.createPartialIndexes();
    this.createTriggers();
  }

  private createWalletsTable(): void {
    this.addSql(`
      CREATE TABLE wallets (
        id uuid PRIMARY KEY,
        player_id text NOT NULL,
        currency char(3) NOT NULL,
        balance numeric(19,2) NOT NULL,
        version integer NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency),
        CONSTRAINT chk_wallets_balance_non_negative CHECK (balance >= 0),
        CONSTRAINT chk_wallets_version_positive CHECK (version >= 1),
        CONSTRAINT chk_wallets_currency_format CHECK (currency ~ '^[A-Z]{3}$')
      );
    `);
  }

  private createWagerTransactionsTable(): void {
    this.addSql(`
      CREATE TABLE wager_transactions (
        id uuid PRIMARY KEY,
        provider_id text NOT NULL,
        external_transaction_id text NOT NULL,
        idempotency_key text NOT NULL,
        payload_hash char(64) NOT NULL,
        wallet_id uuid NOT NULL REFERENCES wallets(id),
        player_id text NOT NULL,
        round_id text NOT NULL,
        game_id text NOT NULL,
        kind text NOT NULL,
        status text NOT NULL,
        amount numeric(19,2) NOT NULL,
        currency char(3) NOT NULL,
        reference_external_transaction_id text NULL,
        reference_transaction_id uuid NULL REFERENCES wager_transactions(id),
        failure_code text NULL,
        observed_balance numeric(19,2) NULL,
        reference_attempts integer NOT NULL DEFAULT 0,
        next_reference_attempt_at timestamptz NULL,
        created_at timestamptz NOT NULL,
        processed_at timestamptz NULL,
        updated_at timestamptz NOT NULL,
        CONSTRAINT uq_wager_transactions_idempotency_key UNIQUE (idempotency_key),
        CONSTRAINT uq_wager_transactions_provider_external_id UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT chk_wager_transactions_amount_non_negative CHECK (amount >= 0),
        CONSTRAINT chk_wager_transactions_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT chk_wager_transactions_kind CHECK (
          kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')
        ),
        CONSTRAINT chk_wager_transactions_status CHECK (
          status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')
        ),
        CONSTRAINT chk_wager_transactions_failure_code_coherence CHECK (
          (failure_code IS NOT NULL AND status IN ('REJECTED', 'FAILED')) OR
          (failure_code IS NULL AND status NOT IN ('REJECTED', 'FAILED'))
        ),
        CONSTRAINT chk_wager_transactions_processed_at_coherence CHECK (
          (processed_at IS NOT NULL AND status = 'PROCESSED') OR
          (processed_at IS NULL AND status <> 'PROCESSED')
        ),
        CONSTRAINT chk_wager_transactions_reference_required CHECK (
          (kind IN ('REFUND', 'ROLLBACK') AND reference_external_transaction_id IS NOT NULL) OR
          (kind NOT IN ('REFUND', 'ROLLBACK'))
        )
      );
    `);
  }

  private createPartialIndexes(): void {
    this.addSql(`
      CREATE UNIQUE INDEX uq_idx_wager_transactions_processed_reversal
      ON wager_transactions (reference_transaction_id)
      WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK');
    `);

    this.addSql(`
      CREATE INDEX idx_wager_transactions_pending_reference_retry
      ON wager_transactions (next_reference_attempt_at)
      WHERE status = 'PENDING_REFERENCE';
    `);
  }

  private createTriggers(): void {
    this.addSql(`
      CREATE OR REPLACE FUNCTION trg_fn_wager_transactions_protect_terminal_and_identity()
      RETURNS TRIGGER AS $$
      BEGIN
        IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') THEN
          RAISE EXCEPTION 'Cannot update transaction in terminal status: %', OLD.status
            USING ERRCODE = 'check_violation';
        END IF;

        IF NEW.provider_id <> OLD.provider_id OR
           NEW.external_transaction_id <> OLD.external_transaction_id OR
           NEW.idempotency_key <> OLD.idempotency_key OR
           NEW.payload_hash <> OLD.payload_hash OR
           NEW.wallet_id <> OLD.wallet_id OR
           NEW.player_id <> OLD.player_id OR
           NEW.round_id <> OLD.round_id OR
           NEW.game_id <> OLD.game_id OR
           NEW.kind <> OLD.kind OR
           NEW.amount <> OLD.amount OR
           NEW.currency <> OLD.currency OR
           NEW.created_at <> OLD.created_at THEN
          RAISE EXCEPTION 'Cannot mutate immutable identity columns of wager_transactions'
            USING ERRCODE = 'check_violation';
        END IF;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER trg_wager_transactions_before_update
      BEFORE UPDATE ON wager_transactions
      FOR EACH ROW
      EXECUTE FUNCTION trg_fn_wager_transactions_protect_terminal_and_identity();
    `);

    this.addSql(`
      CREATE OR REPLACE FUNCTION trg_fn_wager_transactions_prevent_delete()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'Deleting records from wager_transactions is strictly prohibited for financial auditing'
          USING ERRCODE = 'check_violation';
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER trg_wager_transactions_before_delete
      BEFORE DELETE ON wager_transactions
      FOR EACH ROW
      EXECUTE FUNCTION trg_fn_wager_transactions_prevent_delete();
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TRIGGER IF EXISTS trg_wager_transactions_before_delete ON wager_transactions;`);
    this.addSql(`DROP FUNCTION IF EXISTS trg_fn_wager_transactions_prevent_delete();`);
    this.addSql(`DROP TRIGGER IF EXISTS trg_wager_transactions_before_update ON wager_transactions;`);
    this.addSql(`DROP FUNCTION IF EXISTS trg_fn_wager_transactions_protect_terminal_and_identity();`);
    this.addSql(`DROP INDEX IF EXISTS idx_wager_transactions_pending_reference_retry;`);
    this.addSql(`DROP INDEX IF EXISTS uq_idx_wager_transactions_processed_reversal;`);
    this.addSql(`DROP TABLE IF EXISTS wager_transactions;`);
    this.addSql(`DROP TABLE IF EXISTS wallets;`);
  }
}
