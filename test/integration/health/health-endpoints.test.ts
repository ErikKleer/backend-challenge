import { afterAll, afterEach, beforeAll, describe, it, expect } from "bun:test";
import { Global, type INestApplication, Module, type Provider } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { MikroORM } from "@mikro-orm/postgresql";
import type { SQSClient } from "@aws-sdk/client-sqs";
import config from "../../../mikro-orm.config";
import { AuthModule } from "../../../src/auth/auth.module";
import { HealthModule } from "../../../src/health/health.module";
import { createSqsClient } from "../../../src/messaging/infrastructure/sqs/sqs-client.factory";
import { SqsQueueUrlResolver } from "../../../src/messaging/infrastructure/sqs/sqs-queue-url.resolver";
import { SqsReadinessCheck } from "../../../src/messaging/infrastructure/sqs/sqs-readiness-check";
import {
  POSTGRES_READINESS_CHECK_TOKEN,
  type ReadinessCheck,
  SQS_READINESS_CHECK_TOKEN,
} from "../../../src/shared/application/readiness-check.port";
import { ObservabilityModule } from "../../../src/shared/infrastructure/observability/observability.module";
import { PostgresReadinessCheck } from "../../../src/shared/infrastructure/persistence/postgres-readiness-check";
import { createTestDatabase, type TestDatabaseContext } from "../../support/database";
import { createTestQueues, type TestQueues } from "../../support/sqs";

// Porta em que nada escuta: a conexão é recusada na hora
const CLOSED_PORT_URL = "http://127.0.0.1:1";

let db: TestDatabaseContext;
let queues: TestQueues;
let previousTimeout: string | undefined;
const apps: INestApplication[] = [];
const extraClients: SQSClient[] = [];
const extraOrms: MikroORM[] = [];

beforeAll(async () => {
  db = await createTestDatabase();
  queues = await createTestQueues();
  previousTimeout = process.env.HEALTH_CHECK_TIMEOUT_MS;
  // Curto o bastante para o teste de timeout não demorar; longo para um LocalStack saudável
  process.env.HEALTH_CHECK_TIMEOUT_MS = "1500";
});

afterEach(async () => {
  while (apps.length > 0) {
    await apps.pop()!.close();
  }
});

afterAll(async () => {
  if (previousTimeout === undefined) {
    delete process.env.HEALTH_CHECK_TIMEOUT_MS;
  } else {
    process.env.HEALTH_CHECK_TIMEOUT_MS = previousTimeout;
  }
  for (const client of extraClients) {
    client.destroy();
  }
  for (const orm of extraOrms) {
    await orm.close(true);
  }
  await queues.teardown();
  await db.teardown();
});

function realPostgresCheck(): ReadinessCheck {
  return new PostgresReadinessCheck(db.orm.em as never);
}

function realSqsCheck(): ReadinessCheck {
  return new SqsReadinessCheck(
    queues.client,
    new SqsQueueUrlResolver(queues.client, queues.transactionsQueueName),
  );
}

/** SQS com o cliente apontado para uma porta fechada. */
function unreachableSqsCheck(): ReadinessCheck {
  const client = createSqsClient({
    region: "us-east-1",
    endpoint: CLOSED_PORT_URL,
    credentials: { accessKeyId: "dummy", secretAccessKey: "dummy" },
    requestTimeoutMs: 3000,
  });
  extraClients.push(client);
  return new SqsReadinessCheck(client, new SqsQueueUrlResolver(client, queues.transactionsQueueName));
}

/** PostgreSQL com o pool apontado para uma porta fechada (sem conectar no boot). */
async function unreachablePostgresCheck(): Promise<ReadinessCheck> {
  const orm = await MikroORM.init({
    ...config,
    clientUrl: "postgresql://postgres:postgres@127.0.0.1:1/wagering_db",
    connect: false,
  });
  extraOrms.push(orm);
  return new PostgresReadinessCheck(orm.em as never);
}

async function startApp(
  checks: { postgres: ReadinessCheck; sqs: ReadinessCheck },
  extraProviders: Provider[] = [],
): Promise<{ app: INestApplication; baseUrl: string }> {
  @Global()
  @Module({
    providers: [
      { provide: POSTGRES_READINESS_CHECK_TOKEN, useValue: checks.postgres },
      { provide: SQS_READINESS_CHECK_TOKEN, useValue: checks.sqs },
      ...extraProviders,
    ],
    exports: [POSTGRES_READINESS_CHECK_TOKEN, SQS_READINESS_CHECK_TOKEN],
  })
  class ChecksModule {}

  @Module({
    imports: [
      ObservabilityModule.forRoot({ level: "silent" }),
      AuthModule,
      ChecksModule,
      HealthModule.forRoot(),
    ],
  })
  class TestAppModule {}

  const app = await NestFactory.create(TestAppModule, { logger: false });
  await app.listen(0);
  apps.push(app);
  return { app, baseUrl: await app.getUrl() };
}

describe("GET /health/live", () => {
  it("answers 200 without credentials and without touching any dependency", async () => {
    const { baseUrl } = await startApp({
      postgres: await unreachablePostgresCheck(),
      sqs: unreachableSqsCheck(),
    });

    const response = await fetch(`${baseUrl}/health/live`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });
});

describe("GET /health/ready", () => {
  it("answers 200 with both dependencies up, with no authentication header", async () => {
    const { baseUrl } = await startApp({ postgres: realPostgresCheck(), sqs: realSqsCheck() });

    const response = await fetch(`${baseUrl}/health/ready`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      checks: { postgres: "up", sqs: "up" },
    });
  });

  it("answers 503 naming SQS when the broker is unreachable, while liveness stays 200", async () => {
    const { baseUrl } = await startApp({ postgres: realPostgresCheck(), sqs: unreachableSqsCheck() });

    const ready = await fetch(`${baseUrl}/health/ready`);
    const live = await fetch(`${baseUrl}/health/live`);

    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({
      status: "unavailable",
      checks: { postgres: "up", sqs: "down" },
    });
    expect(live.status).toBe(200);
  });

  it("answers 503 naming PostgreSQL when the database is unreachable, without leaking connection details", async () => {
    const { baseUrl } = await startApp({
      postgres: await unreachablePostgresCheck(),
      sqs: realSqsCheck(),
    });

    const ready = await fetch(`${baseUrl}/health/ready`);
    const text = await ready.text();

    expect(ready.status).toBe(503);
    expect(JSON.parse(text)).toEqual({
      status: "unavailable",
      checks: { postgres: "down", sqs: "up" },
    });
    expect(text).not.toContain("127.0.0.1");
    expect(text).not.toContain("postgres:postgres");
    expect((await fetch(`${baseUrl}/health/live`)).status).toBe(200);
  });

  it("reports SQS down when the queue no longer exists", async () => {
    const missing = new SqsReadinessCheck(
      queues.client,
      new SqsQueueUrlResolver(queues.client, `${queues.transactionsQueueName}-missing`),
    );
    const { baseUrl } = await startApp({ postgres: realPostgresCheck(), sqs: missing });

    const ready = await fetch(`${baseUrl}/health/ready`);

    expect(ready.status).toBe(503);
    expect(((await ready.json()) as { checks: unknown }).checks).toEqual({ postgres: "up", sqs: "down" });
  });

  it("answers 503 for draining during shutdown while liveness stays 200", async () => {
    let releaseShutdown!: () => void;
    const drained = new Promise<void>((resolve) => {
      releaseShutdown = resolve;
    });
    // Faz o papel do consumidor SQS: espera os handlers terminarem em beforeApplicationShutdown
    const slowDrain = { beforeApplicationShutdown: () => drained };
    const { app, baseUrl } = await startApp(
      { postgres: realPostgresCheck(), sqs: realSqsCheck() },
      [{ provide: "SLOW_DRAIN", useValue: slowDrain }],
    );
    expect((await fetch(`${baseUrl}/health/ready`)).status).toBe(200);

    const closing = app.close();
    try {
      const ready = await fetch(`${baseUrl}/health/ready`);
      const live = await fetch(`${baseUrl}/health/live`);

      expect(ready.status).toBe(503);
      expect(await ready.json()).toEqual({ status: "shutting_down" });
      expect(live.status).toBe(200);
    } finally {
      releaseShutdown();
      await closing;
      apps.pop();
    }
  });
});
