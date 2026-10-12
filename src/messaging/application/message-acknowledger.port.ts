import type { QueueMessage } from "./queue-message";

/**
 * Único ponto por onde o consumidor encerra ou devolve uma mensagem. Existe como porta para
 * que os testes possam envolver o componente real com falha injetada (por exemplo, "morrer"
 * entre o commit e o ack) sem trocar o SQS por um mock.
 */
export interface MessageAcknowledger {
  /** `DeleteMessage`: só deve ser chamado depois do commit do efeito da mensagem. */
  acknowledge(message: QueueMessage): Promise<void>;

  /** `ChangeMessageVisibility`: 0 devolve a mensagem à fila na hora; N adia a próxima entrega. */
  changeVisibility(message: QueueMessage, seconds: number): Promise<void>;
}

export const MESSAGE_ACKNOWLEDGER_TOKEN = Symbol("MessageAcknowledger");
