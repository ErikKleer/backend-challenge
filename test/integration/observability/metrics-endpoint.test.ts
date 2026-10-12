import { afterAll, beforeAll, describe, it, expect } from "bun:test";
import { type INestApplication, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ObservabilityModule } from "../../../src/shared/infrastructure/observability/observability.module";
import { MetricsService } from "../../../src/shared/infrastructure/observability/metrics.service";

@Module({ imports: [ObservabilityModule.forRoot({ level: "silent" })] })
class ProbeModule {}

describe("GET /metrics", () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    app = await NestFactory.create(ProbeModule, { logger: false });
    await app.listen(0);
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  it("is open and serves the Prometheus text format with every instrument", async () => {
    const response = await fetch(`${baseUrl}/metrics`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    for (const name of [
      "wager_transactions_total",
      "wager_duplicates_total",
      "wager_retries_total",
      "sqs_dlq_messages_total",
      "wallet_lock_conflicts_total",
      "outbox_lag_seconds",
      "outbox_published_total",
      "outbox_publish_failures_total",
      "wager_processing_duration_seconds",
      "reconciliation_divergences_total",
    ]) {
      expect(body).toContain(`# TYPE ${name} `);
    }
  });

  it("serves the samples recorded through the shared MetricsService", async () => {
    app.get(MetricsService).recordLockConflict("lock_timeout");

    const body = await (await fetch(`${baseUrl}/metrics`)).text();
    expect(body).toContain('wallet_lock_conflicts_total{type="lock_timeout"} 1');
  });

  it("includes default process metrics", async () => {
    const body = await (await fetch(`${baseUrl}/metrics`)).text();
    expect(body).toContain("process_cpu_user_seconds_total");
  });
});
