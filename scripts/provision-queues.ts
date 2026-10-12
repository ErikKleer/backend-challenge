import { provisionQueues } from "../src/messaging/infrastructure/queue-provisioning";
import { loadConfig } from "../src/shared/infrastructure/config/env.config";

async function main() {
  const config = loadConfig();
  console.log("Provisioning SQS queues...");
  await provisionQueues({
    endpoint: config.AWS_ENDPOINT,
    region: config.AWS_REGION,
    credentials: {
      accessKeyId: config.AWS_ACCESS_KEY_ID,
      secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
    },
    maxReceiveCount: config.SQS_MAX_RECEIVE_COUNT,
    queues: {
      transactions: config.SQS_QUEUE_WAGER_TRANSACTIONS,
      dlq: config.SQS_QUEUE_WAGER_TRANSACTIONS_DLQ,
      events: config.SQS_QUEUE_WAGER_EVENTS,
    },
  });
  console.log("Queues provisioned successfully.");
}

main().catch((err) => {
  console.error("Failed to provision queues:", err);
  process.exit(1);
});
