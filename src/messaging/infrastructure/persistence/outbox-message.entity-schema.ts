import { EntitySchema } from "@mikro-orm/core";

export interface OutboxMessageRow {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date | null;
  publishedAt?: Date | null;
}

export const OutboxMessageEntitySchema = new EntitySchema<OutboxMessageRow>({
  name: "OutboxMessageRow",
  tableName: "outbox_messages",
  properties: {
    id: { type: "uuid", primary: true },
    aggregateId: { fieldName: "aggregate_id", type: "string", columnType: "text" },
    eventType: { fieldName: "event_type", type: "string", columnType: "text" },
    payload: { fieldName: "payload", type: "json", columnType: "jsonb" },
    occurredAt: { fieldName: "occurred_at", type: "Date", columnType: "timestamptz" },
    attempts: { fieldName: "attempts", type: "integer", columnType: "integer", default: 0 },
    nextAttemptAt: {
      fieldName: "next_attempt_at",
      type: "Date",
      columnType: "timestamptz",
      nullable: true,
    },
    publishedAt: {
      fieldName: "published_at",
      type: "Date",
      columnType: "timestamptz",
      nullable: true,
    },
  },
});
