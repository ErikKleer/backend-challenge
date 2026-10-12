import { Migration } from "@mikro-orm/migrations";

export class Migration20261012173002_CreateWalletLedgerEntries extends Migration {
  override async up(): Promise<void> {
    this.createTable();
    this.createImmutabilityTriggers();
  }

  private createTable(): void {
    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id uuid PRIMARY KEY,
        wallet_id uuid NOT NULL REFERENCES wallets(id),
        transaction_id uuid NOT NULL REFERENCES wager_transactions(id),
        direction text NOT NULL,
        amount numeric(19,2) NOT NULL,
        currency char(3) NOT NULL,
        balance_before numeric(19,2) NOT NULL,
        balance_after numeric(19,2) NOT NULL,
        wallet_version integer NOT NULL,
        created_at timestamptz NOT NULL,
        CONSTRAINT uq_wallet_ledger_entries_tx_wallet UNIQUE (transaction_id, wallet_id),
        CONSTRAINT uq_wallet_ledger_entries_wallet_version UNIQUE (wallet_id, wallet_version),
        CONSTRAINT chk_wallet_ledger_entries_direction CHECK (direction IN ('DEBIT', 'CREDIT')),
        CONSTRAINT chk_wallet_ledger_entries_amount_positive CHECK (amount > 0),
        CONSTRAINT chk_wallet_ledger_entries_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT chk_wallet_ledger_entries_balance_before_non_negative CHECK (balance_before >= 0),
        CONSTRAINT chk_wallet_ledger_entries_balance_after_non_negative CHECK (balance_after >= 0),
        CONSTRAINT chk_wallet_ledger_entries_wallet_version_positive CHECK (wallet_version >= 1),
        CONSTRAINT chk_wallet_ledger_entries_arithmetic CHECK (
          (direction = 'DEBIT' AND balance_after = balance_before - amount) OR
          (direction = 'CREDIT' AND balance_after = balance_before + amount)
        )
      );
    `);
  }

  private createImmutabilityTriggers(): void {
    this.addSql(`
      CREATE OR REPLACE FUNCTION trg_fn_wallet_ledger_prevent_modification()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'Wallet ledger entries are strictly append-only. Modifying or deleting records is prohibited.'
          USING ERRCODE = 'check_violation';
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER trg_wallet_ledger_entries_prevent_row_modification
      BEFORE UPDATE OR DELETE ON wallet_ledger_entries
      FOR EACH ROW
      EXECUTE FUNCTION trg_fn_wallet_ledger_prevent_modification();

      CREATE OR REPLACE FUNCTION trg_fn_wallet_ledger_prevent_truncate()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'Truncating wallet ledger entries is strictly prohibited.'
          USING ERRCODE = 'check_violation';
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER trg_wallet_ledger_entries_prevent_truncate
      BEFORE TRUNCATE ON wallet_ledger_entries
      FOR EACH STATEMENT
      EXECUTE FUNCTION trg_fn_wallet_ledger_prevent_truncate();
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TRIGGER IF EXISTS trg_wallet_ledger_entries_prevent_truncate ON wallet_ledger_entries;`);
    this.addSql(`DROP FUNCTION IF EXISTS trg_fn_wallet_ledger_prevent_truncate();`);
    this.addSql(`DROP TRIGGER IF EXISTS trg_wallet_ledger_entries_prevent_row_modification ON wallet_ledger_entries;`);
    this.addSql(`DROP FUNCTION IF EXISTS trg_fn_wallet_ledger_prevent_modification();`);
    this.addSql(`DROP TABLE IF EXISTS wallet_ledger_entries;`);
  }
}
