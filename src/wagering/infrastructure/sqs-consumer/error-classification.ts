import {
  DomainError,
  IdempotencyConflictError,
} from "../../../shared/domain/domain.error";
import type { DlqReason } from "../../../shared/infrastructure/observability/metrics.service";
import {
  PermanentInfrastructureError,
  TransientInfrastructureError,
} from "../../../shared/infrastructure/persistence/postgres-errors";
import { InvalidWagerMessageError } from "./wager-transaction-message";

/**
 * - `business`: o resultado é definitivo e a mensagem está tratada ⇒ ack.
 * - `transient`: tentar de novo pode dar certo ⇒ sem ack, volta com backoff.
 * - `permanent`: nenhuma nova tentativa resolve ⇒ DLQ.
 */
export type ErrorCategory = "business" | "transient" | "permanent";

export interface ErrorClassification {
  category: ErrorCategory;
  /** Código estável para log; nunca a mensagem do erro, que pode citar valores. */
  code: string;
  /** Motivo do rótulo `sqs_dlq_messages_total`; só nos permanentes. */
  dlqReason?: DlqReason;
}

/**
 * Decide o destino de uma mensagem cujo processamento lançou. O resultado de negócio
 * (`PROCESSED`, `REJECTED`, `PENDING_REFERENCE`, replay) não passa por aqui: ele retorna do
 * caso de uso e é sempre confirmado.
 *
 * Um erro desconhecido é tratado como transitório: é mais seguro repetir (a inbox e a
 * idempotência impedem efeito duplicado) e deixar a redrive policy mandar para a DLQ quando
 * o limite de entregas se esgotar, do que descartar uma mensagem por um defeito passageiro.
 */
export function classifyConsumerError(error: unknown): ErrorClassification {
  if (error instanceof InvalidWagerMessageError) {
    return { category: "permanent", code: error.reason.toUpperCase(), dlqReason: "invalid_message" };
  }
  // O provedor reutilizou a chave com outro conteúdo: a resposta é definitiva e a mensagem está tratada
  if (error instanceof IdempotencyConflictError) {
    return { category: "business", code: error.code };
  }
  if (error instanceof TransientInfrastructureError) {
    return { category: "transient", code: error.code };
  }
  if (error instanceof PermanentInfrastructureError) {
    return { category: "permanent", code: error.code, dlqReason: "permanent_failure" };
  }
  // Demais erros de domínio (wallet inexistente, hash de inbox divergente, estado inválido)
  if (error instanceof DomainError) {
    return { category: "permanent", code: error.code, dlqReason: "permanent_failure" };
  }
  return { category: "transient", code: "UNEXPECTED_ERROR" };
}

// Expoente máximo do backoff: evita estouro de 2^n e já excede qualquer teto razoável
const MAX_BACKOFF_EXPONENT = 20;

/**
 * Visibilidade (em segundos) para a próxima entrega: `base * 2^(entrega - 1)`, limitada por
 * `max`. A primeira falha espera `base`, a segunda `2*base`, e assim por diante.
 */
export function retryDelaySeconds(receiveCount: number, baseSeconds: number, maxSeconds: number): number {
  const exponent = Math.min(Math.max(receiveCount - 1, 0), MAX_BACKOFF_EXPONENT);
  return Math.min(maxSeconds, baseSeconds * 2 ** exponent);
}
