import { afterAll, beforeAll, describe, it, expect } from "bun:test";
import { Body, Controller, Get, Inject, Module, Post } from "@nestjs/common";
import { type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { z } from "zod";
import {
  TransactionNotFoundError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
  InvalidMoneyError,
} from "../../../src/shared/domain/domain.error";
import { ObservabilityModule } from "../../../src/shared/infrastructure/observability/observability.module";
import {
  LockTimeoutError,
  PermanentInfrastructureError,
} from "../../../src/shared/infrastructure/persistence/postgres-errors";
import { MoneyPropsSchema } from "../../../src/shared/presentation/money-props.schema";
import { PresentationModule } from "../../../src/shared/presentation/presentation.module";
import { ZodValidationPipe } from "../../../src/shared/presentation/zod-validation.pipe";

const BodySchema = z.object({ amount: MoneyPropsSchema });

@Controller("probe")
class ProbeController {
  @Post("validate")
  public validate(@Body(new ZodValidationPipe(BodySchema)) body: z.output<typeof BodySchema>) {
    return { amount: body.amount.amount };
  }

  @Get("wallet-exists")
  public walletExists(): never {
    throw new WalletAlreadyExistsError("p1", "BRL");
  }

  @Get("wallet-missing")
  public walletMissing(): never {
    throw new WalletNotFoundError("w1");
  }

  @Get("transaction-missing")
  public transactionMissing(): never {
    throw new TransactionNotFoundError("t1");
  }

  @Get("transient")
  public transient(): never {
    throw new LockTimeoutError();
  }

  @Get("unmapped-domain")
  public unmappedDomain(): never {
    throw new InvalidMoneyError("secret internal detail");
  }

  @Get("unexpected")
  public unexpected(): never {
    throw new PermanentInfrastructureError(
      "INSERT INTO wallets VALUES ('w', '12.30') postgres://user:pw@host/db",
    );
  }
}

const logLines: string[] = [];
const logSink = { write: (line: string) => void logLines.push(line) };

@Module({
  imports: [
    ObservabilityModule.forRoot({ level: "info", destination: logSink }),
    PresentationModule,
  ],
  controllers: [ProbeController],
})
class ProbeModule {}

describe("HTTP error responses", () => {
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

  async function expectError(
    response: Response,
    status: number,
    code: string,
  ): Promise<{ error: { code: string; message: string; details?: unknown }; correlationId: string }> {
    expect(response.status).toBe(status);
    const body = (await response.json()) as {
      error: { code: string; message: string; details?: unknown };
      correlationId: string;
    };
    expect(body.error.code).toBe(code);
    expect(typeof body.error.message).toBe("string");
    expect(body.correlationId).toBe(response.headers.get("x-correlation-id") ?? "");
    expect(body.correlationId.length).toBeGreaterThan(0);
    return body;
  }

  it("maps validation failures to 400 VALIDATION_ERROR with per-field details", async () => {
    const response = await fetch(`${baseUrl}/probe/validate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: { amount: "10.5", currency: "BRL" } }),
    });

    const body = await expectError(response, 400, "VALIDATION_ERROR");
    expect(body.error.details).toEqual([
      { path: "amount", message: expect.stringContaining("exactly 2 decimal places") },
    ]);
  });

  it("maps a request without body to 400 VALIDATION_ERROR", async () => {
    const response = await fetch(`${baseUrl}/probe/validate`, { method: "POST" });

    await expectError(response, 400, "VALIDATION_ERROR");
  });

  it("maps malformed JSON to 400 VALIDATION_ERROR without echoing the parser message", async () => {
    const response = await fetch(`${baseUrl}/probe/validate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });

    const body = await expectError(response, 400, "VALIDATION_ERROR");
    expect(body.error.message).toBe("Malformed request");
  });

  it("passes a valid body through", async () => {
    const response = await fetch(`${baseUrl}/probe/validate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: { amount: "10.50", currency: "BRL" } }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ amount: "10.50" });
  });

  it("maps WalletAlreadyExistsError to 409", async () => {
    await expectError(await fetch(`${baseUrl}/probe/wallet-exists`), 409, "WALLET_ALREADY_EXISTS");
  });

  it("maps not found errors to 404", async () => {
    await expectError(await fetch(`${baseUrl}/probe/wallet-missing`), 404, "WALLET_NOT_FOUND");
    await expectError(
      await fetch(`${baseUrl}/probe/transaction-missing`),
      404,
      "TRANSACTION_NOT_FOUND",
    );
  });

  it("maps unknown routes to 404 NOT_FOUND in the same envelope", async () => {
    await expectError(await fetch(`${baseUrl}/probe/nope`), 404, "NOT_FOUND");
  });

  it("maps transient infrastructure errors to 503 with Retry-After", async () => {
    const response = await fetch(`${baseUrl}/probe/transient`);

    await expectError(response, 503, "TRANSIENT_FAILURE");
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("hides the cause of unexpected errors behind 500 INTERNAL_ERROR", async () => {
    const response = await fetch(`${baseUrl}/probe/unexpected`);
    const text = await response.clone().text();

    const body = await expectError(response, 500, "INTERNAL_ERROR");
    expect(body.error.message).toBe("Internal server error");
    expect(text).not.toContain("postgres://");
    expect(text).not.toContain("12.30");
  });

  it("logs unexpected infrastructure errors without the SQL or its values", async () => {
    logLines.length = 0;
    await fetch(`${baseUrl}/probe/unexpected`);

    const unhandled = logLines.filter((line) => line.includes("unhandled exception"));
    expect(unhandled).toHaveLength(1);
    expect(unhandled[0]).toContain("PERMANENT_INFRASTRUCTURE_ERROR");
    expect(unhandled[0]).not.toContain("12.30");
    expect(unhandled[0]).not.toContain("postgres://");
  });

  it("does not leak details of unmapped domain errors", async () => {
    const response = await fetch(`${baseUrl}/probe/unmapped-domain`);
    const text = await response.clone().text();

    await expectError(response, 500, "INTERNAL_ERROR");
    expect(text).not.toContain("secret internal detail");
  });

  it("reuses a valid incoming X-Correlation-Id in the envelope", async () => {
    const response = await fetch(`${baseUrl}/probe/wallet-missing`, {
      headers: { "X-Correlation-Id": "trace-123" },
    });

    const body = await expectError(response, 404, "WALLET_NOT_FOUND");
    expect(body.correlationId).toBe("trace-123");
  });
});
