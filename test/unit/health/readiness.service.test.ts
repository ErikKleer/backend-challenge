import { describe, it, expect } from "bun:test";
import type { ReadinessCheck } from "../../../src/shared/application/readiness-check.port";
import { AppLogger } from "../../../src/shared/infrastructure/observability/app-logger";
import { ReadinessService } from "../../../src/health/readiness.service";

const logger = new AppLogger({ level: "silent" });

function stub(name: string, check: (signal: AbortSignal) => Promise<void>): ReadinessCheck {
  return { name, check };
}

const up = (name: string) => stub(name, async () => {});
const delayed = (name: string, ms: number) =>
  stub(name, () => new Promise<void>((resolve) => setTimeout(resolve, ms)));

describe("ReadinessService", () => {
  it("is ready when every dependency answers", async () => {
    const service = new ReadinessService([up("postgres"), up("sqs")], logger, 200);

    expect(await service.evaluate()).toEqual({
      ready: true,
      status: "ok",
      checks: { postgres: "up", sqs: "up" },
    });
  });

  it("reports which dependency failed and keeps the other one's state", async () => {
    const failing = stub("sqs", async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.7:4566");
    });
    const service = new ReadinessService([up("postgres"), failing], logger, 200);

    expect(await service.evaluate()).toEqual({
      ready: false,
      status: "unavailable",
      checks: { postgres: "up", sqs: "down" },
    });
  });

  it("treats a dependency that does not answer within the deadline as down, and aborts it", async () => {
    let aborted = false;
    const hanging = stub(
      "postgres",
      (signal) =>
        new Promise<void>(() => {
          signal.addEventListener("abort", () => {
            aborted = true;
          });
        }),
    );
    const service = new ReadinessService([hanging, up("sqs")], logger, 50);

    const startedAt = Date.now();
    const report = await service.evaluate();

    expect(report.checks).toEqual({ postgres: "down", sqs: "up" });
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(aborted).toBe(true);
  });

  it("runs the checks in parallel", async () => {
    const service = new ReadinessService([delayed("postgres", 300), delayed("sqs", 300)], logger, 1000);

    const startedAt = Date.now();
    const report = await service.evaluate();

    expect(report.ready).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(550);
  });

  it("answers not ready without consulting the dependencies once shutdown begins", async () => {
    let calls = 0;
    const counting = stub("postgres", async () => {
      calls += 1;
    });
    const service = new ReadinessService([counting], logger, 200);

    service.onModuleDestroy();

    expect(await service.evaluate()).toEqual({ ready: false, status: "shutting_down" });
    expect(calls).toBe(0);
  });
});
