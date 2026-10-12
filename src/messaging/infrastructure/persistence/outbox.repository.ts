import type { EntityManager } from "@mikro-orm/postgresql";
import type { OutboxRepository } from "../../application/outbox.repository.port";
import type { OutboxMessage } from "../../domain/outbox-message";
import { MikroOrmUnitOfWork } from "../../../shared/infrastructure/persistence/mikro-orm-unit-of-work";
import { classifyPostgreSqlError } from "../../../shared/infrastructure/persistence/postgres-error-classifier";
import type { OutboxMessageRow } from "./outbox-message.entity-schema";
import { toOptionalDate } from "../../../shared/infrastructure/persistence/timestamps";
import { OutboxMessagePersistenceMapper } from "./outbox-message.mapper";

const SELECT_COLS = `
  id,
  aggregate_id as "aggregateId",
  event_type as "eventType",
  payload,
  occurred_at as "occurredAt",
  attempts,
  next_attempt_at as "nextAttemptAt",
  published_at as "publishedAt"
`;

export class MikroOrmOutboxRepository implements OutboxRepository {
  /**
   * Exige transação ativa: a outbox só tem sentido na mesma transação SQL da mudança
   * financeira (enqueue) ou sob o lock de claim (claimDue/save). Não há fallback para o
   * EntityManager raiz, que executaria em autocommit e soltaria o lock imediatamente.
   */
  private get em(): EntityManager {
    return MikroOrmUnitOfWork.getCurrentEntityManager();
  }

  public async enqueue(message: OutboxMessage): Promise<boolean> {
    try {
      const row = OutboxMessagePersistenceMapper.toRow(message);
      const res = await this.em.execute<Array<{ id: string }>>(
        `INSERT INTO outbox_messages (
          id, aggregate_id, event_type, payload, occurred_at,
          attempts, next_attempt_at, published_at
        ) VALUES (?, ?, ?, ?::jsonb, ?, ?, ?, ?)
        ON CONFLICT (id) DO NOTHING
        RETURNING id`,
        [
          row.id,
          row.aggregateId,
          row.eventType,
          JSON.stringify(row.payload),
          row.occurredAt,
          row.attempts,
          row.nextAttemptAt,
          row.publishedAt,
        ],
      );
      return Boolean(res && res.length > 0);
    } catch (error) {
      throw classifyPostgreSqlError(error);
    }
  }

  public async claimDue(now: Date, limit: number): Promise<OutboxMessage[]> {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError("claimDue limit must be a positive integer");
    }

    try {
      const rows = await this.em.execute<OutboxMessageRow[]>(
        `SELECT ${SELECT_COLS}
         FROM outbox_messages
         WHERE published_at IS NULL
           AND COALESCE(next_attempt_at, occurred_at) <= ?
         ORDER BY COALESCE(next_attempt_at, occurred_at) ASC, id ASC
         LIMIT ?
         FOR UPDATE SKIP LOCKED`,
        [now, limit],
      );
      return (rows ?? []).map((row) => OutboxMessagePersistenceMapper.toDomain(row));
    } catch (error) {
      throw classifyPostgreSqlError(error);
    }
  }

  public async oldestPendingOccurredAt(): Promise<Date | undefined> {
    try {
      const rows = await this.em.execute<Array<{ oldest: string | Date | null }>>(
        `SELECT MIN(occurred_at) AS oldest FROM outbox_messages WHERE published_at IS NULL`,
      );
      return toOptionalDate(rows?.[0]?.oldest);
    } catch (error) {
      throw classifyPostgreSqlError(error);
    }
  }

  public async save(message: OutboxMessage): Promise<void> {
    try {
      const row = OutboxMessagePersistenceMapper.toRow(message);
      await this.em.execute(
        `UPDATE outbox_messages
         SET attempts = ?, next_attempt_at = ?, published_at = ?
         WHERE id = ?`,
        [row.attempts, row.nextAttemptAt, row.publishedAt, row.id],
      );
    } catch (error) {
      throw classifyPostgreSqlError(error);
    }
  }
}
