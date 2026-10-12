import {
  type CallHandler,
  type ExecutionContext as NestExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import type { Observable } from "rxjs";
import { AppLogger } from "./app-logger";
import { getContext, runWithContext } from "./execution-context";

// Tipos mínimos do Express (sem @types/express).
interface HttpRequest {
  method: string;
  path: string;
  route?: { path?: string };
}

interface HttpResponse {
  statusCode: number;
  once(event: "finish", listener: () => void): unknown;
}

const QUIET_PATHS = new Set(["/metrics", "/health/live", "/health/ready"]);

/**
 * Log de acesso: método, rota, status e duração. Sem corpo, query string ou
 * cabeçalhos. A linha sai no evento `finish` da resposta, quando o status
 * final (inclusive o de exception filters) já é conhecido.
 */
export class HttpAccessLogInterceptor implements NestInterceptor {
  constructor(private readonly logger: AppLogger) {}

  public intercept(
    context: NestExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    if (context.getType() !== "http") {
      return next.handle();
    }

    const http = context.switchToHttp();
    const req = http.getRequest<HttpRequest>();
    const res = http.getResponse<HttpResponse>();
    const startedAt = process.hrtime.bigint();
    const executionContext = getContext();

    res.once("finish", () => {
      const durationMs =
        Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const status = res.statusCode;
      const fields = {
        method: req.method,
        // Padrão da rota (/wallets/:id), não o path real: baixa cardinalidade.
        route: req.route?.path ?? req.path,
        status,
        durationMs: Math.round(durationMs * 100) / 100,
      };
      const emit = () => {
        if (status >= 500) {
          this.logger.error("http request completed", fields);
        } else if (status >= 400) {
          this.logger.warn("http request completed", fields);
        } else if (QUIET_PATHS.has(req.path)) {
          this.logger.debug("http request completed", fields);
        } else {
          this.logger.info("http request completed", fields);
        }
      };

      // O listener roda fora da cadeia assíncrona da requisição.
      if (executionContext) {
        runWithContext(executionContext, emit);
      } else {
        emit();
      }
    });

    return next.handle();
  }
}
