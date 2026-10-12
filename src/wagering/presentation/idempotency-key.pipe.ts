import { createParamDecorator, type ExecutionContext, type PipeTransform } from "@nestjs/common";
import { RequestValidationError } from "../../shared/presentation/request-validation.error";

export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

/**
 * Valida o header `Idempotency-Key`, que é a fonte da verdade da idempotência. Ausente
 * ou vazio tem código próprio (`MISSING_IDEMPOTENCY_KEY`), para o provedor distinguir
 * "esqueci o header" de "payload inválido".
 */
export class IdempotencyKeyPipe implements PipeTransform<unknown, string> {
  public transform(value: unknown): string {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new RequestValidationError(
        `${IDEMPOTENCY_KEY_HEADER} header is required`,
        [{ path: IDEMPOTENCY_KEY_HEADER, message: "header is required and must not be empty" }],
        "MISSING_IDEMPOTENCY_KEY",
      );
    }
    if (value.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      throw new RequestValidationError(`${IDEMPOTENCY_KEY_HEADER} header is too long`, [
        {
          path: IDEMPOTENCY_KEY_HEADER,
          message: `header must have at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
        },
      ]);
    }
    return value;
  }
}

interface RequestWithHeaders {
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Parâmetro `@IdempotencyKey()`: o `@Headers()` do Nest não aceita pipes, então a
 * validação roda aqui, antes do corpo.
 */
export const IdempotencyKey = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const request = context.switchToHttp().getRequest<RequestWithHeaders>();
  return new IdempotencyKeyPipe().transform(request.headers[IDEMPOTENCY_KEY_HEADER.toLowerCase()]);
});
