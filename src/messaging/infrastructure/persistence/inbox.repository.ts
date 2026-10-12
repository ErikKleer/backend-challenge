import type { EntityManager } from "@mikro-orm/postgresql";
import type { InboxRepository } from "../../application/inbox.repository.port";
import type { InboxMessage } from "../../domain/inbox-message";
import { MikroOrmUnitOfWork } from "../../../shared/infrastructure/persistence/mikro-orm-unit-of-work";
import { classifyPostgreSqlError } from "../../../shared/infrastructure/persistence/postgres-error-classifier";
import type { InboxMessageRow } from "./inbox-message.entity-schema";
import { InboxMessagePersistenceMapper } from "./inbox-message.mapper";

export class MikroOrmInboxRepository implements InboxRepository {
  /**
   * Exige transação ativa: o registro de inbox participa da mesma transação SQL
   * do efeito financeiro (README §11). Se o processamento falhar, a inbox desfaz junto
   * e a mensagem redelivered é processada de novo.
   */
  private get em(): EntityManager {
    return MikroOrmUnitOfWork.getCurrentEntityManager();
  }

  public async tryReceive(message: InboxMessage): Promise<boolean> {
    try {
      const row = InboxMessagePersistenceMapper.toRow(message);
      const res = await this.em.execute<Array<{ messageId: string }>>(
        `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (consumer_name, message_id) DO NOTHING
         RETURNING message_id as "messageId"`,
        [row.consumerName, row.messageId, row.payloadHash, row.receivedAt, row.processedAt],
      );
      return Boolean(res && res.length > 0);
    } catch (error) {
      throw classifyPostgreSqlError(error);
    }
  }

  public async find(consumerName: string, messageId: string): Promise<InboxMessage | null> {
    try {
      const rows = await this.em.execute<InboxMessageRow[]>(
        `SELECT consumer_name as "consumerName",
                message_id as "messageId",
                payload_hash as "payloadHash",
                received_at as "receivedAt",
                processed_at as "processedAt"
         FROM inbox_messages
         WHERE consumer_name = ? AND message_id = ?`,
        [consumerName, messageId],
      );
      if (!rows || rows.length === 0 || !rows[0]) return null;
      return InboxMessagePersistenceMapper.toDomain(rows[0]);
    } catch (error) {
      throw classifyPostgreSqlError(error);
    }
  }

  public async markProcessed(message: InboxMessage): Promise<void> {
    try {
      const row = InboxMessagePersistenceMapper.toRow(message);
      await this.em.execute(
        `UPDATE inbox_messages SET processed_at = ?
         WHERE consumer_name = ? AND message_id = ?`,
        [row.processedAt, row.consumerName, row.messageId],
      );
    } catch (error) {
      throw classifyPostgreSqlError(error);
    }
  }
}
