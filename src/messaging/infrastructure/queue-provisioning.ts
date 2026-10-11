import { SQSClient, CreateQueueCommand } from "@aws-sdk/client-sqs";

export interface ProvisionQueuesOptions {
  endpoint?: string;
  region: string;
  credentials: { accessKeyId: string; secretAccessKey: string };
  queues: {
    transactions: string;
    dlq: string;
    events: string;
  };
}

export async function provisionQueues(options: ProvisionQueuesOptions): Promise<void> {
  const client = new SQSClient({
    region: options.region,
    endpoint: options.endpoint,
    credentials: options.credentials,
  });

  const dlqResponse = await client.send(
    new CreateQueueCommand({
      QueueName: options.queues.dlq,
      Attributes: {
        FifoQueue: "true",
        MessageRetentionPeriod: "1209600", // 14 dias
      },
    })
  );
  const dlqArn = dlqResponse.QueueArn;

  await client.send(
    new CreateQueueCommand({
      QueueName: options.queues.transactions,
      Attributes: {
        FifoQueue: "true",
        VisibilityTimeout: "30",
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: dlqArn,
          maxReceiveCount: "5",
        }),
      },
    })
  );

  await client.send(
    new CreateQueueCommand({
      QueueName: options.queues.events,
      Attributes: {
        FifoQueue: "true",
        VisibilityTimeout: "30",
      },
    })
  );
}
