import type { DlqReason } from "../../shared/infrastructure/observability/metrics.service";
import type { QueueMessage } from "./queue-message";

export interface DeadLetterInfo {
  reason: DlqReason;
  /** Código estável do erro (`INVALID_JSON`, `WALLET_NOT_FOUND`, …) para triagem na DLQ. */
  errorCode: string;
}

/** Envia explicitamente uma mensagem sem conserto possível para a fila de mensagens mortas. */
export interface DeadLetterPublisher {
  /** Resolve só depois de o broker aceitar a mensagem; a fila original ainda não foi tocada. */
  send(message: QueueMessage, info: DeadLetterInfo): Promise<void>;
}

export const DEAD_LETTER_PUBLISHER_TOKEN = Symbol("DeadLetterPublisher");
