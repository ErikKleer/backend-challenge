import type { IdGenerator } from "../../application/id-generator.port";
import { runWithContext } from "./execution-context";

// Tipos mínimos do Express: evita depender de @types/express só por três métodos.
interface HttpRequest {
  header(name: string): string | undefined;
}

interface HttpResponse {
  setHeader(name: string, value: string): unknown;
}

export const CORRELATION_ID_HEADER = "X-Correlation-Id";

// Limita o que é aceito do cliente: o valor vai para logs e cabeçalhos,
// então caracteres de controle e tamanhos arbitrários são descartados.
const VALID_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Abre o contexto de execução da requisição. Reaproveita o `X-Correlation-Id`
 * recebido quando válido (rastreio ponta a ponta entre serviços); caso
 * contrário gera um novo UUID. O valor é sempre devolvido na resposta.
 */
export function createCorrelationIdMiddleware(idGenerator: IdGenerator) {
  return (req: HttpRequest, res: HttpResponse, next: () => void): void => {
    const incoming = req.header(CORRELATION_ID_HEADER);
    const correlationId =
      incoming !== undefined && VALID_CORRELATION_ID.test(incoming)
        ? incoming
        : idGenerator.generate();

    res.setHeader(CORRELATION_ID_HEADER, correlationId);
    runWithContext({ correlationId }, () => next());
  };
}
