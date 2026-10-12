export interface ValidationIssue {
  path: string; // Caminho do campo, ex.: "initialBalance.amount"; vazio para o corpo inteiro
  message: string;
}

/**
 * Corpo, parâmetro ou cabeçalho da requisição fora do contrato. Vive na camada de
 * apresentação: não é regra de negócio, e o filtro global o traduz em 400.
 */
export class RequestValidationError extends Error {
  constructor(
    message: string,
    public readonly issues: ValidationIssue[],
  ) {
    super(message);
    this.name = "RequestValidationError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
