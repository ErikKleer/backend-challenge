import {
  type ArgumentsHost,
  type ExceptionFilter,
  HttpException,
} from "@nestjs/common";
import type { IdGenerator } from "../application/id-generator.port";
import { DomainError } from "../domain/domain.error";
import { UuidV7IdGenerator } from "../infrastructure/id/uuid-v7-id-generator";
import type { AppLogger } from "../infrastructure/observability/app-logger";
import { getContext } from "../infrastructure/observability/execution-context";
import {
  InfrastructureError,
  TransientInfrastructureError,
} from "../infrastructure/persistence/postgres-errors";
import type { ErrorResponse } from "./error-response";
import {
  DOMAIN_ERROR_HTTP_STATUS,
  TRANSIENT_RETRY_AFTER_SECONDS,
} from "./http-error-mapping";
import { RequestValidationError } from "./request-validation.error";

// Tipos mínimos do Express (sem @types/express).
interface HttpResponse {
  status(code: number): HttpResponse;
  setHeader(name: string, value: string): unknown;
  getHeader(name: string): unknown;
  json(body: unknown): unknown;
}

const CORRELATION_ID_HEADER = "X-Correlation-Id";

/**
 * Filtro global: toda falha vira o envelope `{ error: { code, message, details? },
 * correlationId }`. Erros inesperados respondem 500 genérico; a causa só vai para o log.
 */
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(
    private readonly logger: AppLogger,
    private readonly idGenerator: IdGenerator = new UuidV7IdGenerator(),
  ) {}

  public catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== "http") {
      throw exception;
    }

    const response = host.switchToHttp().getResponse<HttpResponse>();
    const { status, body } = this.translate(exception, response);

    if (status === 503) {
      response.setHeader("Retry-After", String(TRANSIENT_RETRY_AFTER_SECONDS));
    }
    response.status(status).json(body);
  }

  private translate(
    exception: unknown,
    response: HttpResponse,
  ): { status: number; body: ErrorResponse } {
    const correlationId = this.correlationIdOf(response);
    const respond = (status: number, code: string, message: string, details?: unknown) => ({
      status,
      body: {
        error: { code, message, ...(details !== undefined ? { details } : {}) },
        correlationId,
      },
    });

    if (exception instanceof RequestValidationError) {
      return respond(400, "VALIDATION_ERROR", exception.message, exception.issues);
    }

    if (exception instanceof DomainError) {
      const status = DOMAIN_ERROR_HTTP_STATUS[exception.code];
      if (status !== undefined) {
        return respond(status, exception.code, exception.message);
      }
    }

    if (exception instanceof TransientInfrastructureError) {
      this.logger.warn("transient failure", { code: exception.code });
      return respond(503, "TRANSIENT_FAILURE", "Temporary failure, retry the request");
    }

    const clientError = this.clientErrorOf(exception);
    if (clientError !== undefined) {
      return respond(clientError.status, clientError.code, clientError.message);
    }

    this.logger.error("unhandled exception", this.describeUnexpected(exception));
    return respond(500, "INTERNAL_ERROR", "Internal server error");
  }

  /**
   * Erros de infraestrutura trazem o SQL com os parâmetros na mensagem (inclusive
   * valores monetários), que não podem ir para o log; deles só se aproveitam o código
   * e os frames da pilha.
   */
  private describeUnexpected(exception: unknown): Record<string, unknown> {
    if (!(exception instanceof Error)) {
      return { errorName: typeof exception };
    }
    if (exception instanceof InfrastructureError) {
      const frames = (exception.stack ?? "")
        .split("\n")
        .filter((line) => /^\s+at /.test(line))
        .join("\n");
      return { errorName: exception.name, errorCode: exception.code, stack: frames };
    }
    return {
      errorName: exception.name,
      errorMessage: exception.message,
      stack: exception.stack,
    };
  }

  /**
   * Falhas do body-parser (JSON malformado) ocorrem antes do middleware de correlação:
   * nesse caso não há contexto nem header, então um id novo é gerado e devolvido.
   */
  private correlationIdOf(response: HttpResponse): string {
    const fromContext = getContext()?.correlationId;
    if (fromContext !== undefined) {
      return fromContext;
    }
    const fromHeader = response.getHeader(CORRELATION_ID_HEADER);
    if (typeof fromHeader === "string") {
      return fromHeader;
    }
    const generated = this.idGenerator.generate();
    response.setHeader(CORRELATION_ID_HEADER, generated);
    return generated;
  }

  /**
   * Erros 4xx do framework (rota inexistente, JSON malformado do body-parser, corpo
   * grande demais). Em 400 a mensagem do parser não é repassada, para não vazar detalhes.
   */
  private clientErrorOf(
    exception: unknown,
  ): { status: number; code: string; message: string } | undefined {
    let status: number | undefined;
    let message = "Request error";
    if (exception instanceof HttpException) {
      status = exception.getStatus();
      message = exception.message;
    } else if (typeof exception === "object" && exception !== null) {
      const candidate = exception as { status?: unknown; statusCode?: unknown; expose?: unknown };
      const value = candidate.status ?? candidate.statusCode;
      if (typeof value === "number" && candidate.expose === true) {
        status = value;
        message = (exception as Error).message;
      }
    }

    if (status === undefined || status < 400 || status >= 500) {
      return undefined;
    }
    if (status === 400) {
      return { status, code: "VALIDATION_ERROR", message: "Malformed request" };
    }
    return { status, code: status === 404 ? "NOT_FOUND" : "REQUEST_ERROR", message };
  }
}
