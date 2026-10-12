import type { InboxMessage } from "../domain/inbox-message";

export interface InboxRepository {
  /**
   * Registra a mensagem com `ON CONFLICT DO NOTHING` sobre `(consumer_name, message_id)`.
   * Retorna true se é a primeira recepção; false se já havia sido recebida (redelivery).
   * Deve ser chamado dentro do UnitOfWork do processamento.
   */
  tryReceive(message: InboxMessage): Promise<boolean>;

  find(consumerName: string, messageId: string): Promise<InboxMessage | null>;

  /**
   * Persiste `processedAt` da mensagem.
   */
  markProcessed(message: InboxMessage): Promise<void>;
}

export const INBOX_REPOSITORY_TOKEN = Symbol("InboxRepository");
