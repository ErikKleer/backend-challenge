import { Controller, Get, Inject, Res } from "@nestjs/common";
import { MetricsService } from "./metrics.service";

interface HttpResponse {
  setHeader(name: string, value: string): unknown;
}

/** Endpoint de scrape do Prometheus; aberto, como os health checks (README §2). */
@Controller("metrics")
export class MetricsController {
  constructor(@Inject(MetricsService) private readonly metrics: MetricsService) {}

  @Get()
  public async scrape(
    @Res({ passthrough: true }) res: HttpResponse,
  ): Promise<string> {
    res.setHeader("Content-Type", this.metrics.contentType());
    return this.metrics.render();
  }
}
