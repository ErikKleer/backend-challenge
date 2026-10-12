import { Controller, Get, HttpStatus, Inject, Res } from "@nestjs/common";
import { Public } from "../auth/public.decorator";
import { ReadinessService, type ReadinessReport } from "./readiness.service";

interface HttpResponse {
  status(code: number): unknown;
}

/** Abertos, sem autenticação (README §2 e §9). */
@Public()
@Controller("health")
export class HealthController {
  constructor(@Inject(ReadinessService) private readonly readiness: ReadinessService) {}

  /** Liveness: o processo responde. Não toca em dependência, para não reiniciar o app por culpa delas. */
  @Get("live")
  public live(): { status: "ok" } {
    return { status: "ok" };
  }

  /** Readiness: PostgreSQL e SQS alcançáveis e a instância não está encerrando. */
  @Get("ready")
  public async ready(
    @Res({ passthrough: true }) res: HttpResponse,
  ): Promise<Omit<ReadinessReport, "ready">> {
    const { ready, ...body } = await this.readiness.evaluate();
    res.status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return body;
  }
}
