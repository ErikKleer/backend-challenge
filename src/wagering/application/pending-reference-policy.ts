/**
 * Backoff das transações em `PENDING_REFERENCE`: a primeira espera é `baseDelayMs`,
 * dobra a cada tentativa até `maxDelayMs`, e `maxAttempts` esgotadas rejeitam a
 * transação com `REFERENCE_NOT_FOUND`.
 */
export interface PendingReferencePolicy {
  baseDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
}

export const PENDING_REFERENCE_POLICY_TOKEN = Symbol("PendingReferencePolicy");
