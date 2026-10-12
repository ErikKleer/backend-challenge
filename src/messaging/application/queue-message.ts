/** Mensagem recebida da fila, já sem os tipos do SDK: é o que o consumidor e o handler enxergam. */
export interface QueueMessage {
  /** Id atribuído pelo broker (`MessageId` do SQS), não o `messageId` do envelope de negócio. */
  id: string;
  /** Válido só durante a visibilidade desta entrega; identifica ack e mudança de visibilidade. */
  receiptHandle: string;
  body: string;
  groupId?: string;
  /** `ApproximateReceiveCount`: quantas vezes o broker já entregou a mensagem (1 na primeira). */
  receiveCount: number;
}

export interface QueueMessageHandler {
  /**
   * Processa uma mensagem até o fim, incluindo ack ou devolução. Não deve lançar: o que
   * escapar é registrado pelo consumidor e a mensagem volta após a visibilidade.
   */
  handle(message: QueueMessage): Promise<void>;
}
