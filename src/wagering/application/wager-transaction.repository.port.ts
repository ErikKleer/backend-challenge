import type { WagerTransaction } from "../domain/wager-transaction";

export interface WagerTransactionRepository {
  /**
   * Insere a transação no banco com ON CONFLICT DO NOTHING (sem alvo específico,
   * cobrindo as unicidades idempotency_key e (provider_id, external_transaction_id)).
   * Retorna true se inserida; false se já existia (conflito/duplicata).
   */
  insertIfAbsent(transaction: WagerTransaction): Promise<boolean>;

  /**
   * Busca a transação por id.
   */
  findById(id: string): Promise<WagerTransaction | null>;

  /**
   * Busca a transação por chave de idempotência.
   */
  findByIdempotencyKey(key: string): Promise<WagerTransaction | null>;

  /**
   * Busca a transação pelo par natural (provider_id, external_transaction_id).
   */
  findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null>;

  /**
   * Busca eventual transação de reversão (PROCESSED REFUND ou ROLLBACK)
   * que referencie a transação informada.
   */
  findReversalOf(referenceTransactionId: string): Promise<WagerTransaction | null>;

  /**
   * Atualiza os campos mutáveis da transação (status, failureCode, referenceTransactionId,
   * observedBalance, referenceAttempts, nextReferenceAttemptAt, processedAt, updatedAt).
   */
  save(transaction: WagerTransaction): Promise<void>;
}

export const WAGER_TRANSACTION_REPOSITORY_TOKEN = Symbol("WagerTransactionRepository");
