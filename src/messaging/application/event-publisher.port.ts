import type { OutboxMessage } from "../domain/outbox-message";

export interface EventPublisher {
  /**
   * Entrega o evento ao broker. Resolve somente quando o broker confirmou o recebimento
   * e rejeita em qualquer falha (timeout, indisponibilidade, fila inexistente).
   *
   * Semântica *at-least-once*: o chamador pode publicar a mesma mensagem mais de uma vez
   * (ex.: o processo morreu entre publicar e confirmar no outbox), então o consumidor
   * deduplica por `eventId`.
   */
  publish(message: OutboxMessage): Promise<void>;
}

export const EVENT_PUBLISHER_TOKEN = Symbol("EventPublisher");
