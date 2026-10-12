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
   * `occurred_at` do evento pendente mais antigo (inclusive os que aguardam retry), ou
   * `undefined` se a outbox está em dia. Base do `outbox_lag_seconds`; é uma leitura simples,
   * sem lock, então não bloqueia nem é bloqueada pelos publishers.
   */
  oldestPendingOccurredAt(): Promise<Date | undefined>;

  /**
   * Persiste o estado mutável (attempts, nextAttemptAt, publishedAt).
   */
  save(message: OutboxMessage): Promise<void>;
}

export const OUTBOX_REPOSITORY_TOKEN = Symbol("OutboxRepository");
