import { afterAll, beforeAll, describe, it, expect } from "bun:test";
import { Controller, Get, type INestApplication, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ObservabilityModule } from "../../../src/shared/infrastructure/observability/observability.module";
import { getContext } from "../../../src/shared/infrastructure/observability/execution-context";

@Controller("probe")
class ProbeController {
  @Get()
  public async probe() {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { correlationId: getContext()?.correlationId };
  }
}

@Module({ imports: [ObservabilityModule.forRoot({ level: "silent" })], controllers: [ProbeController] })
class ProbeModule {}

describe("correlation id middleware", () => {
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

  it("generates a correlation id and returns it in the response header", async () => {
    const response = await fetch(`${baseUrl}/probe`);
    const body = (await response.json()) as { correlationId: string };

    expect(response.headers.get("x-correlation-id")).toBe(body.correlationId);
    expect(body.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("reuses a valid incoming X-Correlation-Id", async () => {
    const response = await fetch(`${baseUrl}/probe`, {
      headers: { "X-Correlation-Id": "trace-abc.123" },
    });
    const body = (await response.json()) as { correlationId: string };

    expect(body.correlationId).toBe("trace-abc.123");
    expect(response.headers.get("x-correlation-id")).toBe("trace-abc.123");
  });

  it("replaces an invalid incoming correlation id", async () => {
    const response = await fetch(`${baseUrl}/probe`, {
      headers: { "X-Correlation-Id": "x".repeat(200) },
    });
    const body = (await response.json()) as { correlationId: string };

    expect(body.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("does not leak context between concurrent requests", async () => {
    const ids = Array.from({ length: 30 }, (_, i) => `req-${i}`);
    const bodies = await Promise.all(
      ids.map(async (id) => {
        const response = await fetch(`${baseUrl}/probe`, {
          headers: { "X-Correlation-Id": id },
        });
        return (await response.json()) as { correlationId: string };
      }),
    );

    expect(bodies.map((b) => b.correlationId)).toEqual(ids);
  });
});
