import type { OutboxMessage } from "../domain/outbox-message";

export interface OutboxRepository {
  /**
   * Grava a mensagem com `ON CONFLICT DO NOTHING` sobre o id (= eventId determinístico).
   * Retorna true se inserida; false se o evento já estava na outbox.
   * Deve ser chamado dentro do UnitOfWork da transação financeira.
   */
  enqueue(message: OutboxMessage): Promise<boolean>;

  /**
   * Reclama até `limit` mensagens pendentes e vencidas (`COALESCE(next_attempt_at, occurred_at) <= now`)
   * com `FOR UPDATE SKIP LOCKED`: publishers concorrentes nunca recebem a mesma linha.
   * O lock dura até o fim da transação corrente, então publicação e `save` devem ocorrer nela.
   */
  claimDue(now: Date, limit: number): Promise<OutboxMessage[]>;

  /**
   * Persiste o estado mutável (attempts, nextAttemptAt, publishedAt).
   */
  save(message: OutboxMessage): Promise<void>;
}

export const OUTBOX_REPOSITORY_TOKEN = Symbol("OutboxRepository");
