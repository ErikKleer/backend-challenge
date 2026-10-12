import { InvalidMessageStateError } from "../../shared/domain/domain.error";
import type { IntegrationEvent } from "./integration-event";

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

/**
 * Política de backoff exponencial, sem jitter para manter os testes determinísticos.
 * O atraso da tentativa N é `min(maxDelayMs, baseDelayMs * 2^(N-1))`.
 */
export interface OutboxBackoffPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_OUTBOX_BACKOFF: OutboxBackoffPolicy = {
  baseDelayMs: 1000,
  maxDelayMs: 60_000,
};

// Evita overflow do expoente; 2^30 já excede qualquer teto razoável
const MAX_BACKOFF_EXPONENT = 30;

/**
 * Evento de integração gravado na mesma transação SQL da alteração financeira.
 * Um worker o publica depois do commit. Não há limite de tentativas: um evento confirmado
 * não pode ser perdido, então a falha vira defasagem observável (`outbox_lag_seconds`).
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  /**
   * O id da mensagem é o `eventId` (determinístico): reenfileirar o mesmo evento
   * resulta na mesma linha e o repositório descarta a duplicata.
   */
  public static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      { ...event.toJSON() },
      event.occurredAt,
      0,
    );
  }

  public static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  // ---- Getters de estado

  public get attempts(): number {
    return this._attempts;
  }

  public get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  public get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  // ---- Consultas

  public isPending(): boolean {
    return this._publishedAt === undefined;
  }

  /**
   * Pronta para publicar: pendente e com `COALESCE(nextAttemptAt, occurredAt) <= now`,
   * a mesma expressão usada pelo índice de claim.
   */
  public isDue(now: Date): boolean {
    if (!this.isPending()) {
      return false;
    }
    const dueAt = this._nextAttemptAt ?? this.occurredAt;
    return dueAt.getTime() <= now.getTime();
  }

  // ---- Transições

  public markPublished(at: Date): void {
    this.assertPending("mark as published");
    this._publishedAt = at;
    this._nextAttemptAt = undefined;
  }

  /**
   * Registra uma tentativa falha: incrementa `attempts` e agenda a próxima com backoff exponencial.
   */
  public scheduleRetry(now: Date, policy: OutboxBackoffPolicy = DEFAULT_OUTBOX_BACKOFF): void {
    this.assertPending("schedule a retry for");
    if (policy.baseDelayMs <= 0 || policy.maxDelayMs < policy.baseDelayMs) {
      throw new InvalidMessageStateError(
        "Outbox backoff requires baseDelayMs > 0 and maxDelayMs >= baseDelayMs",
      );
    }

    this._attempts += 1;
    const exponent = Math.min(this._attempts - 1, MAX_BACKOFF_EXPONENT);
    const delayMs = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** exponent);
    this._nextAttemptAt = new Date(now.getTime() + delayMs);
  }

  private assertPending(action: string): void {
    if (!this.isPending()) {
      throw new InvalidMessageStateError(
        `Cannot ${action} outbox message '${this.id}': already published`,
      );
    }
  }
}
