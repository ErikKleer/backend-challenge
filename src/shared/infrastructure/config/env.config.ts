import { z } from "zod";

/**
 * `z.coerce.boolean()` trata a string "false" como verdadeira (qualquer string não vazia é
 * truthy), o que ligaria um papel que o operador desligou. Aqui só "false", "0", "no", "off"
 * e vazio desligam.
 */
const booleanFlag = (defaultValue: boolean) =>
  z
    .preprocess(
      (value) =>
        typeof value === "string"
          ? !["", "false", "0", "no", "off"].includes(value.trim().toLowerCase())
          : value,
      z.boolean(),
    )
    .default(defaultValue);

export const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().url(),
  DB_POOL_MAX: z.coerce.number().default(10),
  DB_LOCK_TIMEOUT_MS: z.coerce.number().default(2000),
  AWS_REGION: z.string().default("us-east-1"),
  AWS_ENDPOINT: z.string().url().optional(),
  AWS_ACCESS_KEY_ID: z.string().default("dummy"),
  AWS_SECRET_ACCESS_KEY: z.string().default("dummy"),
  SQS_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
  SQS_QUEUE_WAGER_TRANSACTIONS: z.string(),
  SQS_QUEUE_WAGER_TRANSACTIONS_DLQ: z.string(),
  SQS_QUEUE_WAGER_EVENTS: z.string(),
  SQS_WAIT_SECONDS: z.coerce.number().int().min(0).max(20).default(10),
  SQS_MAX_MESSAGES: z.coerce.number().int().min(1).max(10).default(10),
  SQS_CONSUMER_CONCURRENCY: z.coerce.number().int().positive().default(5),
  SQS_RETRY_BASE_SECONDS: z.coerce.number().int().positive().default(2),
  SQS_RETRY_MAX_SECONDS: z.coerce.number().int().positive().default(60),
  /** Deve coincidir com o `maxReceiveCount` da redrive policy provisionada. */
  SQS_MAX_RECEIVE_COUNT: z.coerce.number().int().positive().default(5),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  LOG_LEVEL: z.string().default("info"),
  PENDING_REFERENCE_BASE_DELAY_MS: z.coerce.number().int().positive().default(2000),
  PENDING_REFERENCE_MAX_DELAY_MS: z.coerce.number().int().positive().default(60000),
  PENDING_REFERENCE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(8),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(500),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().default(10),
  ENABLE_HTTP: booleanFlag(true),
  ENABLE_SQS_CONSUMER: booleanFlag(true),
  ENABLE_OUTBOX_PUBLISHER: booleanFlag(true),
  ENABLE_PENDING_WORKER: booleanFlag(true),
});

export type EnvConfig = z.infer<typeof envSchema>;

export function loadConfig(env = process.env): EnvConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    console.error("❌ Invalid environment configuration:", result.error.format());
    process.exit(1);
  }
  return result.data;
}
