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
  queues: {
    transactions: string;
    dlq: string;
    events: string;
  };
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
      // Caso a fila já existisse com atributos idênticos ou tenha sido criada
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

export async function provisionQueues(options: ProvisionQueuesOptions): Promise<void> {
  const client = new SQSClient({
    region: options.region,
    endpoint: options.endpoint,
    credentials: options.credentials,
  });

  // 1. Criar ou atualizar a DLQ
  const dlqUrl = await ensureQueue(client, options.queues.dlq, {
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
    throw new Error(`Failed to retrieve QueueArn for DLQ: ${options.queues.dlq}`);
  }

  // 2. Criar ou atualizar a fila de transações com RedrivePolicy apontando para o ARN da DLQ
  const txRedrivePolicy = JSON.stringify({
    deadLetterTargetArn: dlqArn,
    maxReceiveCount: "5",
  });

  await ensureQueue(client, options.queues.transactions, {
    FifoQueue: "true",
    VisibilityTimeout: "30",
    RedrivePolicy: txRedrivePolicy,
  });

  // 3. Criar ou atualizar a fila de eventos
  await ensureQueue(client, options.queues.events, {
    FifoQueue: "true",
    VisibilityTimeout: "30",
  });
}


