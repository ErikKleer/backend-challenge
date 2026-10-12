export abstract class InfrastructureError extends Error {
  public abstract readonly code: string;
  public override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = new.target.name;
    this.cause = cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}


/**
 * Erro transitório de infraestrutura que permite retry (lock timeout, deadlock,
 * serialização concorrente, falha temporária de rede/conexão).
 */
export class TransientInfrastructureError extends InfrastructureError {
  public readonly code: string;

  constructor(message: string, code = "TRANSIENT_INFRASTRUCTURE_ERROR", cause?: unknown) {
    super(message, cause);
    this.code = code;
  }
}

/**
 * Erro permanente de infraestrutura que não deve ser retentado (violação estrutural,
 * SQL malformado, etc).
 */
export class PermanentInfrastructureError extends InfrastructureError {
  public readonly code: string;

  constructor(message: string, code = "PERMANENT_INFRASTRUCTURE_ERROR", cause?: unknown) {
    super(message, cause);
    this.code = code;
  }
}

/**
 * Erro transitório de timeout ao tentar obter row-lock na wallet.
 */
export class LockTimeoutError extends TransientInfrastructureError {
  constructor(message = "Lock acquisition timed out on wallet", cause?: unknown) {
    super(message, "LOCK_TIMEOUT", cause);
  }
}

/**
 * Erro de conflito de concorrência otimista (versão da wallet divergente).
 * É transitório e elegível para nova tentativa da transação completa.
 */
export class WalletVersionConflictError extends TransientInfrastructureError {
  constructor(
    message = "Wallet version conflict: expected version does not match current database version",
    cause?: unknown,
  ) {
    super(message, "WALLET_VERSION_CONFLICT", cause);
  }
}

/**
 * Erro específico de violação de constraint UNIQUE com o nome da constraint.
 */
export class UniqueConstraintViolationError extends PermanentInfrastructureError {
  public readonly constraint?: string;

  constructor(message: string, constraint?: string, cause?: unknown) {
    super(message, "UNIQUE_VIOLATION", cause);
    this.constraint = constraint;
  }
}
