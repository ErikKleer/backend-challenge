import { Migration } from "@mikro-orm/migrations";

export class Migration20261012173003_CreateInboxAndOutboxMessages extends Migration {
  override async up(): Promise<void> {
    this.createInboxTable();
    this.createOutboxTable();
  }

  private createInboxTable(): void {
    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name text NOT NULL,
        message_id text NOT NULL,
        payload_hash char(64) NOT NULL,
        received_at timestamptz NOT NULL,
        processed_at timestamptz NULL,
        CONSTRAINT pk_inbox_messages PRIMARY KEY (consumer_name, message_id)
      );
    `);
  }

  private createOutboxTable(): void {
    this.addSql(`
      CREATE TABLE outbox_messages (
        id uuid PRIMARY KEY,
        aggregate_id text NOT NULL,
        event_type text NOT NULL,
        payload jsonb NOT NULL,
        occurred_at timestamptz NOT NULL,
        attempts integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz NULL,
        published_at timestamptz NULL
      );
    `);

    // Claim index: busca eficiente de mensagens pendentes prontas para publicação
    this.addSql(`
      CREATE INDEX idx_outbox_messages_claim
      ON outbox_messages (COALESCE(next_attempt_at, occurred_at))
      WHERE published_at IS NULL;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP INDEX IF EXISTS idx_outbox_messages_claim;`);
    this.addSql(`DROP TABLE IF EXISTS outbox_messages;`);
    this.addSql(`DROP TABLE IF EXISTS inbox_messages;`);
  }
}
