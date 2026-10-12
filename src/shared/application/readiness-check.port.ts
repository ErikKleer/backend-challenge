/**
 * Verificação de uma dependência externa para o `/health/ready`. A implementação
 * deve falhar (rejeitar) quando a dependência não responde; quem chama impõe o
 * prazo e cancela via `signal`.
 */
export interface ReadinessCheck {
  /** Nome exposto no corpo do health, por exemplo `postgres`. */
  readonly name: string;
  check(signal: AbortSignal): Promise<void>;
}

export const POSTGRES_READINESS_CHECK_TOKEN = Symbol("PostgresReadinessCheck");
export const SQS_READINESS_CHECK_TOKEN = Symbol("SqsReadinessCheck");
