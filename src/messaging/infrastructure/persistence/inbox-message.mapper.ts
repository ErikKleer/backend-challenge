import { InboxMessage } from "../../domain/inbox-message";
import { toDate, toOptionalDate } from "../../../shared/infrastructure/persistence/timestamps";
import type { InboxMessageRow } from "./inbox-message.entity-schema";

export class InboxMessagePersistenceMapper {
  public static toRow(domain: InboxMessage): InboxMessageRow {
    return {
      consumerName: domain.consumerName,
      messageId: domain.messageId,
      payloadHash: domain.payloadHash,
      receivedAt: domain.receivedAt,
      processedAt: domain.processedAt ?? null,
    };
  }

  public static toDomain(row: InboxMessageRow): InboxMessage {
    return InboxMessage.rehydrate({
      consumerName: row.consumerName,
      messageId: row.messageId,
      payloadHash: row.payloadHash.trim(), // char(64) devolve sem padding, mas evita surpresas
      receivedAt: toDate(row.receivedAt),
      processedAt: toOptionalDate(row.processedAt),
    });
  }
}
