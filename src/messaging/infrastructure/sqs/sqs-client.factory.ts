import { SQSClient } from "@aws-sdk/client-sqs";

export interface SqsClientOptions {
  region: string;
  endpoint?: string;
  credentials: { accessKeyId: string; secretAccessKey: string };
  /** Teto de uma chamada ao SQS; precisa ser curto porque o publisher a faz com a transação aberta. */
  requestTimeoutMs: number;
}

// Conexão que não abre em 2s já está indisponível; esperar mais só alonga a transação do publisher
const MAX_CONNECTION_TIMEOUT_MS = 2000;

/**
 * Cria o cliente SQS a partir da configuração de ambiente. `maxAttempts: 1` desliga o retry
 * interno do SDK: quem repete é o outbox (com backoff persistido), e um retry escondido aqui
 * multiplicaria o tempo que a transação do publisher fica aberta.
 */
export function createSqsClient(options: SqsClientOptions): SQSClient {
  return new SQSClient({
    region: options.region,
    endpoint: options.endpoint,
    credentials: options.credentials,
    maxAttempts: 1,
    requestHandler: {
      requestTimeout: options.requestTimeoutMs,
      connectionTimeout: Math.min(options.requestTimeoutMs, MAX_CONNECTION_TIMEOUT_MS),
    },
  });
}
