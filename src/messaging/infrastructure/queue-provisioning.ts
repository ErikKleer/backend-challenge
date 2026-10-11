import {
  SQSClient,
  CreateQueueCommand,
  GetQueueUrlCommand,
  GetQueueAttributesCommand,
  SetQueueAttributesCommand,
} from "@aws-sdk/client-sqs";

export interface ProvisionQueuesOptions {
  endpoint?: string;
  region: string;
  credentials: { accessKeyId: string; secretAccessKey: string };
  prefix?: string;
  visibilityTimeoutSeconds?: number;
  maxReceiveCount?: number;
  queues?: {
    transactions?: string;
    dlq?: string;
    events?: string;
  };
}

export interface ProvisionedQueuesResult {
  dlqUrl: string;
  dlqArn: string;
  transactionsUrl: string;
  eventsUrl: string;
}

async function ensureQueue(
  client: SQSClient,
  queueName: string,
  attributes: Record<string, string>
): Promise<string> {
  try {
    const res = await client.send(
      new CreateQueueCommand({
        QueueName: queueName,
        Attributes: attributes,
      })
    );
    if (res.QueueUrl) {
      await client.send(
        new SetQueueAttributesCommand({
          QueueUrl: res.QueueUrl,
          Attributes: attributes,
        })
      );
      return res.QueueUrl;
    }
  } catch (err: unknown) {
    const errorName = (err as { name?: string; Code?: string })?.name || (err as { Code?: string })?.Code;
    if (errorName === "QueueNameExists" || errorName === "QueueAlreadyExists") {
      const urlRes = await client.send(new GetQueueUrlCommand({ QueueName: queueName }));
      const queueUrl = urlRes.QueueUrl!;
      await client.send(
        new SetQueueAttributesCommand({
          QueueUrl: queueUrl,
          Attributes: attributes,
        })
      );
      return queueUrl;
    }
    throw err;
  }
  const urlRes = await client.send(new GetQueueUrlCommand({ QueueName: queueName }));
  return urlRes.QueueUrl!;
}

export async function provisionQueues(options: ProvisionQueuesOptions): Promise<ProvisionedQueuesResult> {
  const client = new SQSClient({
    region: options.region,
    endpoint: options.endpoint,
    credentials: options.credentials,
  });

  const prefix = options.prefix ?? "";
  const visibilityTimeout = String(options.visibilityTimeoutSeconds ?? 30);
  const maxReceiveCount = String(options.maxReceiveCount ?? 5);

  const dlqQueueName = prefix + (options.queues?.dlq ?? "wager-transactions-dlq.fifo");
  const txQueueName = prefix + (options.queues?.transactions ?? "wager-transactions.fifo");
  const eventsQueueName = prefix + (options.queues?.events ?? "wager-events.fifo");

  // 1. Criar ou atualizar a DLQ
  const dlqUrl = await ensureQueue(client, dlqQueueName, {
    FifoQueue: "true",
    MessageRetentionPeriod: "1209600", // 14 dias
  });

  const dlqAttrs = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: dlqUrl,
      AttributeNames: ["QueueArn"],
    })
  );
  const dlqArn = dlqAttrs.Attributes?.QueueArn;
  if (!dlqArn) {
    throw new Error(`Failed to retrieve QueueArn for DLQ: ${dlqQueueName}`);
  }

  // 2. Criar ou atualizar a fila de transações com RedrivePolicy apontando para o ARN da DLQ
  const txRedrivePolicy = JSON.stringify({
    deadLetterTargetArn: dlqArn,
    maxReceiveCount,
  });

  const transactionsUrl = await ensureQueue(client, txQueueName, {
    FifoQueue: "true",
    VisibilityTimeout: visibilityTimeout,
    RedrivePolicy: txRedrivePolicy,
  });

  // 3. Criar ou atualizar a fila de eventos
  const eventsUrl = await ensureQueue(client, eventsQueueName, {
    FifoQueue: "true",
    VisibilityTimeout: visibilityTimeout,
  });

  return {
    dlqUrl,
    dlqArn,
    transactionsUrl,
    eventsUrl,
  };
}



