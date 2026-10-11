import { z } from "zod";

export const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().url(),
  DB_POOL_MAX: z.coerce.number().default(10),
  DB_LOCK_TIMEOUT_MS: z.coerce.number().default(2000),
  AWS_REGION: z.string().default("us-east-1"),
  AWS_ENDPOINT: z.string().url().optional(),
  AWS_ACCESS_KEY_ID: z.string().default("dummy"),
  AWS_SECRET_ACCESS_KEY: z.string().default("dummy"),
  SQS_QUEUE_WAGER_TRANSACTIONS: z.string(),
  SQS_QUEUE_WAGER_TRANSACTIONS_DLQ: z.string(),
  SQS_QUEUE_WAGER_EVENTS: z.string(),
  LOG_LEVEL: z.string().default("info"),
  ENABLE_HTTP: z.coerce.boolean().default(true),
  ENABLE_SQS_CONSUMER: z.coerce.boolean().default(true),
  ENABLE_OUTBOX_PUBLISHER: z.coerce.boolean().default(true),
  ENABLE_PENDING_WORKER: z.coerce.boolean().default(true),
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
