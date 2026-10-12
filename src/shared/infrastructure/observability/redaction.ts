export const REDACTED = "[Redacted]";

// Chaves cujo valor nunca pode ir para o log: credenciais, valores monetários,
// saldos (qualquer chave que contenha "balance") e payloads de negócio.
const SENSITIVE_KEY = /^(authorization|cookie|amount|money|payload)$|balance/i;

const MAX_DEPTH = 8;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Devolve uma cópia com os valores sensíveis substituídos por `[Redacted]`,
 * em qualquer profundidade e sem diferenciar maiúsculas. Só percorre objetos
 * literais e arrays: `Error`, `Date` e instâncias de classe passam intactos
 * (os serializers do pino cuidam deles). Abaixo de `MAX_DEPTH` o valor inteiro
 * é omitido, o que também protege contra referências circulares.
 */
export function redactSensitive(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) {
    return depth >= MAX_DEPTH
      ? REDACTED
      : value.map((item) => redactSensitive(item, depth + 1));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  if (depth >= MAX_DEPTH) {
    return REDACTED;
  }

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = SENSITIVE_KEY.test(key)
      ? REDACTED
      : redactSensitive(item, depth + 1);
  }
  return result;
}
