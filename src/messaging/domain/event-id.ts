import { createHash } from "node:crypto";

/**
 * Namespace fixo do projeto para UUID v5. Nunca deve mudar: alterá-lo muda todos os
 * eventId derivados e quebra a deduplicação de eventos já publicados.
 */
export const EVENT_ID_NAMESPACE = "3b9f6c1e-7a42-4d58-9c0e-5f2a8b1d6e47";

/**
 * UUID v5 (RFC 4122 §4.3): SHA-1 de namespace + nome, com bits de versão e variante.
 */
export function uuidV5(name: string, namespace: string): string {
  const namespaceBytes = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const hash = createHash("sha1")
    .update(namespaceBytes)
    .update(name, "utf8")
    .digest();

  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50; // version 5
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // variant RFC 4122

  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/**
 * eventId determinístico por (transação, tipo de evento).
 *
 * A mesma transação nunca gera dois eventos do mesmo tipo com ids diferentes. Se o fluxo
 * for reexecutado (redelivery, retry após falha transitória), o outbox recebe o mesmo id e
 * o `ON CONFLICT DO NOTHING` descarta a duplicata; no broker, o id também serve de
 * `MessageDeduplicationId`, e o consumidor o usa para deduplicar.
 */
export function deriveEventId(transactionId: string, eventType: string): string {
  return uuidV5(`${transactionId}:${eventType}`, EVENT_ID_NAMESPACE);
}
