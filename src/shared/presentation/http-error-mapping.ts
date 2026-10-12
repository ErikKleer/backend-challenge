/**
 * Código de erro de domínio → status HTTP. Códigos ausentes aqui não são erro do
 * cliente e viram 500, sem vazar detalhes. Novos endpoints registram aqui os códigos
 * que introduzem.
 */
export const DOMAIN_ERROR_HTTP_STATUS: Readonly<Record<string, number>> = {
  WALLET_ALREADY_EXISTS: 409,
  WALLET_NOT_FOUND: 404,
  TRANSACTION_NOT_FOUND: 404,
  IDEMPOTENCY_CONFLICT: 409,
};

/** Segundos sugeridos ao cliente em respostas 503. */
export const TRANSIENT_RETRY_AFTER_SECONDS = 1;
