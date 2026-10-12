import { afterAll, beforeAll, describe, it, expect } from "bun:test";
import {
  Body,
  Controller,
  Get,
  type INestApplication,
  Module,
  Post,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ObservabilityModule } from "../../../src/shared/infrastructure/observability/observability.module";
import { bindContext } from "../../../src/shared/infrastructure/observability/execution-context";

@Controller("wallets")
class ProbeController {
  @Get("boom")
  public boom() {
    throw new Error("boom");
  }

  @Post(":id")
  public create(@Body() body: unknown) {
    bindContext({ walletId: "wallet-from-handler" });
    return { received: typeof body };
  }
}

const lines: string[] = [];

@Module({
  imports: [
    ObservabilityModule.forRoot({
      level: "debug",
      destination: { write: (line: string) => void lines.push(line) },
    }),
  ],
  controllers: [ProbeController],
})
class ProbeModule {}

async function waitForLine(
  predicate: (line: Record<string, unknown>) => boolean,
  timeoutMs = 2000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find(predicate);
    if (found) {
      return found;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("log line not found");
}

describe("HTTP access log", () => {
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

  it("logs one JSON line with correlationId, route, status and duration, without the body", async () => {
    await fetch(`${baseUrl}/wallets/abc-123`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Correlation-Id": "corr-1" },
      body: JSON.stringify({ amount: "777.77", playerId: "player-1" }),
    });

    const line = await waitForLine((l) => l.correlationId === "corr-1");
    expect(line).toMatchObject({
      level: "info",
      msg: "http request completed",
      method: "POST",
      route: "/wallets/:id",
      status: 201,
      walletId: "wallet-from-handler",
    });
    expect(typeof line.durationMs).toBe("number");
    expect(lines.join("")).not.toContain("777.77");
    expect(lines.join("")).not.toContain("player-1");
  });

  it("logs server errors at error level with the final status", async () => {
    await fetch(`${baseUrl}/wallets/boom`, {
      headers: { "X-Correlation-Id": "corr-2" },
    });

    const line = await waitForLine(
      (l) => l.correlationId === "corr-2" && l.msg === "http request completed",
    );
    expect(line).toMatchObject({ level: "error", status: 500 });
  });
});
