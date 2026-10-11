import { createHash } from "node:crypto";
import { Money } from "../../shared/domain/money";
import type { WagerTransactionKind } from "./wager-transaction-types";

export interface PayloadHashFields {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | null;
}

/**
 * Serializa deterministicamente qualquer valor em JSON canônico:
 * - Chaves de objetos são ordenadas lexicograficamente de forma recursiva.
 * - Valores `undefined` e `null` são omitidos de objetos.
 * - Sem espaços em branco entre delimitadores e separadores.
 * - Instâncias de `Money` são serializadas via `money.toJSON()` ({ amount, currency }).
 * - Datas são serializadas em formato ISO 8601.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  if (value instanceof Money) {
    return canonicalJson(value.toJSON());
  }

  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }

  if (typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const serializedItems = value.map((item) =>
      item === undefined || item === null ? "null" : canonicalJson(item),
    );
    return `[${serializedItems.join(",")}]`;
  }

  // Objeto regular: filtrar chaves com valor undefined ou null e ordenar lexicograficamente
  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj)
    .filter((key) => obj[key] !== undefined && obj[key] !== null)
    .sort();

  const entries = sortedKeys.map(
    (key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`,
  );

  return `{${entries.join(",")}}`;
}

/**
 * Computa o hash canônico SHA-256 em hexadecimal dos campos de negócio da transação.
 * Metadados de transporte como `Idempotency-Key`, `messageId` ou timestamps não participam do hash.
 */
export function computePayloadHash(fields: PayloadHashFields): string {
  const normalized: Record<string, unknown> = {
    providerId: fields.providerId,
    externalTransactionId: fields.externalTransactionId,
    playerId: fields.playerId,
    walletId: fields.walletId,
    roundId: fields.roundId,
    gameId: fields.gameId,
    kind: fields.kind,
    money: fields.money,
  };

  if (
    fields.referenceExternalTransactionId !== undefined &&
    fields.referenceExternalTransactionId !== null
  ) {
    normalized.referenceExternalTransactionId = fields.referenceExternalTransactionId;
  }

  const canonicalString = canonicalJson(normalized);
  return createHash("sha256").update(canonicalString, "utf8").digest("hex");
}
