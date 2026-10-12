/**
 * Erro base para todas as exceções de domínio.
 * Carrega um código estável para mapeamento em APIs e logs.
 */
export abstract class DomainError extends Error {
  public abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Lançado quando a representação ou operação monetária é inválida.
 */
export class InvalidMoneyError extends DomainError {
  public readonly code = "INVALID_MONEY";

  constructor(message: string) {
    super(message);
  }
}

/**
 * Lançado quando operações envolvem moedas distintas.
 */
export class CurrencyMismatchError extends DomainError {
  public readonly code = "CURRENCY_MISMATCH";

  constructor(expected: string, actual: string) {
    super(`Currency mismatch: expected '${expected}', got '${actual}'`);
  }
}

/**
 * Lançado quando uma tentativa de débito excede o saldo disponível.
 */
export class InsufficientFundsError extends DomainError {
  public readonly code = "INSUFFICIENT_FUNDS";

  constructor(message = "Insufficient funds for the requested debit operation") {
    super(message);
  }
}

/**
 * Lançado quando um lançamento no ledger viola a aritmética ou restrições de integridade.
 */
export class InvalidLedgerEntryError extends DomainError {
  public readonly code = "INVALID_LEDGER_ENTRY";

  constructor(message: string) {
    super(message);
  }
}

/**
 * Lançado quando dados ou transições da wallet violam regras de domínio.
 */
export class InvalidWalletError extends DomainError {
  public readonly code = "INVALID_WALLET";

  constructor(message: string) {
    super(message);
  }
}


/**
 * Lançado quando um evento de integração é construído a partir de um estado inconsistente.
 */
export class InvalidIntegrationEventError extends DomainError {
  public readonly code = "INVALID_INTEGRATION_EVENT";

  constructor(message: string) {
    super(message);
  }
}

/**
 * Lançado quando uma mensagem de inbox/outbox é criada ou transicionada de forma inválida.
 */
export class InvalidMessageStateError extends DomainError {
  public readonly code = "INVALID_MESSAGE_STATE";

  constructor(message: string) {
    super(message);
  }
}

/**
 * Lançado quando ocorre uma transição ou operação inválida de estado em WagerTransaction.
 */
export class InvalidTransactionStateError extends DomainError {
  public readonly code = "INVALID_TRANSACTION_STATE";

  constructor(message: string) {
    super(message);
  }
}

/**
 * Lançado quando já existe uma wallet para o mesmo `playerId` e moeda.
 */
export class WalletAlreadyExistsError extends DomainError {
  public readonly code = "WALLET_ALREADY_EXISTS";

  constructor(playerId: string, currency: string) {
    super(`A wallet already exists for player '${playerId}' in currency '${currency}'`);
  }
}

/**
 * Lançado quando a wallet consultada não existe.
 */
export class WalletNotFoundError extends DomainError {
  public readonly code = "WALLET_NOT_FOUND";

  constructor(walletId: string) {
    super(`Wallet '${walletId}' was not found`);
  }
}

/**
 * Lançado quando a transação consultada não existe.
 */
export class TransactionNotFoundError extends DomainError {
  public readonly code = "TRANSACTION_NOT_FOUND";

  constructor(reference: string) {
    super(`Transaction '${reference}' was not found`);
  }
}

/**
 * Lançado quando a chave de idempotência (ou o par provedor + id externo) já pertence a
 * uma transação com conteúdo diferente. Nunca é replay: o provedor reutilizou a chave.
 */
export class IdempotencyConflictError extends DomainError {
  public readonly code = "IDEMPOTENCY_CONFLICT";

  constructor(message: string) {
    super(message);
  }
}

/**
 * Lançado quando um `messageId` já recebido volta com conteúdo diferente. O mesmo id com outro
 * payload não é redelivery: é um produtor reutilizando identificadores, e reprocessar ou
 * descartar em silêncio esconderia o defeito.
 */
export class InboxPayloadMismatchError extends DomainError {
  public readonly code = "INBOX_PAYLOAD_MISMATCH";

  constructor(consumerName: string, messageId: string) {
    super(`Message '${messageId}' was already received by '${consumerName}' with a different payload`);
  }
}
