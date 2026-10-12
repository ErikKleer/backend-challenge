import { EntitySchema } from "@mikro-orm/core";

export interface InboxMessageRow {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date | null;
}

export const InboxMessageEntitySchema = new EntitySchema<InboxMessageRow>({
  name: "InboxMessageRow",
  tableName: "inbox_messages",
  properties: {
    consumerName: { fieldName: "consumer_name", type: "string", columnType: "text", primary: true },
    messageId: { fieldName: "message_id", type: "string", columnType: "text", primary: true },
    payloadHash: { fieldName: "payload_hash", type: "string", columnType: "char(64)" },
    receivedAt: { fieldName: "received_at", type: "Date", columnType: "timestamptz" },
    processedAt: {
      fieldName: "processed_at",
      type: "Date",
      columnType: "timestamptz",
      nullable: true,
    },
  },
});
