import { GetQueueUrlCommand, type SQSClient } from "@aws-sdk/client-sqs";

/**
 * Resolve a URL da fila pelo nome e guarda o resultado: `GetQueueUrl` roda uma vez por
 * processo, não a cada publicação. Uma falha não é cacheada, para que a próxima chamada
 * tente de novo (o broker pode ainda estar subindo no boot).
 */
export class SqsQueueUrlResolver {
  private cached?: Promise<string>;

  constructor(
    private readonly client: SQSClient,
    private readonly queueName: string,
  ) {}

  public resolve(): Promise<string> {
    if (!this.cached) {
      const lookup = this.lookup();
      this.cached = lookup;
      lookup.catch(() => {
        if (this.cached === lookup) {
          this.cached = undefined;
        }
      });
    }
    return this.cached;
  }

  private async lookup(): Promise<string> {
    const result = await this.client.send(new GetQueueUrlCommand({ QueueName: this.queueName }));
    if (!result.QueueUrl) {
      throw new Error(`SQS returned no URL for queue '${this.queueName}'`);
    }
    return result.QueueUrl;
  }
}
