import { OutboxMessage } from "../../domain/outbox-message";
import { toDate, toOptionalDate } from "../../../shared/infrastructure/persistence/timestamps";
import type { OutboxMessageRow } from "./outbox-message.entity-schema";

export class OutboxMessagePersistenceMapper {
  public static toRow(domain: OutboxMessage): OutboxMessageRow {
    return {
      id: domain.id,
      aggregateId: domain.aggregateId,
      eventType: domain.eventType,
      payload: domain.payload as Record<string, unknown>,
      occurredAt: domain.occurredAt,
      attempts: domain.attempts,
      nextAttemptAt: domain.nextAttemptAt ?? null,
      publishedAt: domain.publishedAt ?? null,
    };
  }

  public static toDomain(row: OutboxMessageRow): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: row.id,
      aggregateId: row.aggregateId,
      eventType: row.eventType,
      payload: row.payload,
      occurredAt: toDate(row.occurredAt),
      attempts: row.attempts,
      nextAttemptAt: toOptionalDate(row.nextAttemptAt),
      publishedAt: toOptionalDate(row.publishedAt),
    });
  }
}
