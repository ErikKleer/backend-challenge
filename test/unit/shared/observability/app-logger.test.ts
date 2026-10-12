import { describe, it, expect } from "bun:test";
import { AppLogger } from "../../../../src/shared/infrastructure/observability/app-logger";
import {
  bindContext,
  runWithContext,
} from "../../../../src/shared/infrastructure/observability/execution-context";

function createLogger(level = "debug") {
  const lines: string[] = [];
  const logger = new AppLogger({
    level,
    destination: { write: (line: string) => void lines.push(line) },
  });
  const parsed = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  return { logger, lines, parsed };
}

describe("AppLogger", () => {
  it("emits one JSON line with level, ISO time and message", () => {
    const { logger, parsed } = createLogger();
    logger.info("wager processed", { status: "PROCESSED" });

    const [line] = parsed();
    expect(line).toMatchObject({
      level: "info",
      msg: "wager processed",
      status: "PROCESSED",
    });
    expect(String(line?.time)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("merges the current execution context into every line", async () => {
    const { logger, parsed } = createLogger();

    await runWithContext({ correlationId: "c-1", messageId: "m-1" }, async () => {
      bindContext({ walletId: "w-1", transactionId: "t-1", providerId: "p-1" });
      await Promise.resolve();
      logger.info("step");
    });

    expect(parsed()[0]).toMatchObject({
      correlationId: "c-1",
      messageId: "m-1",
      walletId: "w-1",
      transactionId: "t-1",
      providerId: "p-1",
    });
  });

  it("never emits amount, money, payload or balance values", () => {
    const { logger, lines } = createLogger();
    logger.info("leaky", {
      amount: "123.45",
      money: { amount: "123.45", currency: "BRL" },
      payload: { amount: "123.45" },
      observedBalance: "999.99",
      headers: { authorization: "Bearer secret-token" },
      failureCode: "INSUFFICIENT_FUNDS",
    });

    const output = lines.join("");
    expect(output).not.toContain("123.45");
    expect(output).not.toContain("999.99");
    expect(output).not.toContain("secret-token");
    expect(output).toContain("INSUFFICIENT_FUNDS");
  });

  it("accepts Nest-style calls (context and stack)", () => {
    const { logger, parsed } = createLogger();
    logger.log("Nest application successfully started", "NestApplication");
    logger.error("failed", "Error: stack", "SomeService");

    const [first, second] = parsed();
    expect(first).toMatchObject({ level: "info", context: "NestApplication" });
    expect(second).toMatchObject({
      level: "error",
      stack: "Error: stack",
      context: "SomeService",
    });
  });

  it("respects the configured level", () => {
    const { logger, lines } = createLogger("warn");
    logger.info("hidden");
    logger.warn("shown");
    expect(lines).toHaveLength(1);
  });
});
