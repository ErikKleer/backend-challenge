import { EntitySchema } from "@mikro-orm/core";

export interface WagerTransactionRow {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  status: string;
  amount: string;
  currency: string;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  failureCode?: string | null;
  observedBalance?: string | null;
  referenceAttempts: number;
  nextReferenceAttemptAt?: Date | null;
  createdAt: Date;
  processedAt?: Date | null;
  updatedAt: Date;
}

export const WagerTransactionEntitySchema = new EntitySchema<WagerTransactionRow>({
  name: "WagerTransactionRow",
  tableName: "wager_transactions",
  properties: {
    id: { type: "uuid", primary: true },
    providerId: { fieldName: "provider_id", type: "string", columnType: "text" },
    externalTransactionId: { fieldName: "external_transaction_id", type: "string", columnType: "text" },
    idempotencyKey: { fieldName: "idempotency_key", type: "string", columnType: "text" },
    payloadHash: { fieldName: "payload_hash", type: "string", columnType: "char(64)" },
    walletId: { fieldName: "wallet_id", type: "uuid" },
    playerId: { fieldName: "player_id", type: "string", columnType: "text" },
    roundId: { fieldName: "round_id", type: "string", columnType: "text" },
    gameId: { fieldName: "game_id", type: "string", columnType: "text" },
    kind: { fieldName: "kind", type: "string", columnType: "text" },
    status: { fieldName: "status", type: "string", columnType: "text" },
    amount: { fieldName: "amount", type: "string", columnType: "numeric(19,2)" },
    currency: { fieldName: "currency", type: "string", columnType: "char(3)" },
    referenceExternalTransactionId: {
      fieldName: "reference_external_transaction_id",
      type: "string",
      columnType: "text",
      nullable: true,
    },
    referenceTransactionId: {
      fieldName: "reference_transaction_id",
      type: "uuid",
      nullable: true,
    },
    failureCode: { fieldName: "failure_code", type: "string", columnType: "text", nullable: true },
    observedBalance: {
      fieldName: "observed_balance",
      type: "string",
      columnType: "numeric(19,2)",
      nullable: true,
    },
    referenceAttempts: {
      fieldName: "reference_attempts",
      type: "integer",
      columnType: "integer",
      default: 0,
    },
    nextReferenceAttemptAt: {
      fieldName: "next_reference_attempt_at",
      type: "Date",
      columnType: "timestamptz",
      nullable: true,
    },
    createdAt: { fieldName: "created_at", type: "Date", columnType: "timestamptz" },
    processedAt: {
      fieldName: "processed_at",
      type: "Date",
      columnType: "timestamptz",
      nullable: true,
    },
    updatedAt: { fieldName: "updated_at", type: "Date", columnType: "timestamptz" },
  },
});
