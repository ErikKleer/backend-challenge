import { createServer } from "node:net";
import { resolve } from "node:path";
import type { SubmitWagerTransactionCommand } from "../../src/wagering/application/submit-wager-transaction.command";
import type { TestDatabaseContext } from "./database";
import { waitFor } from "./parallel";
import { TEST_SQS_ENDPOINT, type TestQueues } from "./sqs";

const REPO_ROOT = resolve(__dirname, "..", "..");

/** Papéis do processo (README §10–§11): o que a instância faz além de responder HTTP. */
export interface AppRoles {
  sqsConsumer?: boolean;
  outboxPublisher?: boolean;
  pendingWorker?: boolean;
}

export interface AppInstanceOptions {
  /** Só para identificar a instância nas mensagens de erro. */
  name: string;
  db: TestDatabaseContext;
  queues: TestQueues;
  roles?: AppRoles;
  /** Variáveis extras, por exemplo `FAULT_INJECTION` ou `OUTBOX_BATCH_SIZE`. */
  env?: Record<string, string>;
  /** Teto do pool de conexões desta instância (default 10). */
  poolMax?: number;
  /** Prazo para `/health/ready` responder 200 (default 30s: o Bun compila TypeScript no boot). */
  readyTimeoutMs?: number;
}

/** Linha de log estruturado (pino) ou, se não for JSON, o texto cru em `msg`. */
export interface LogEntry {
  msg?: string;
  [key: string]: unknown;
}

async function freePort(): Promise<number> {
  return new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

/**
 * Uma instância real da aplicação (`bun run src/main.ts`) como processo filho, ligada ao
 * PostgreSQL e às filas do LocalStack de teste. Várias instâncias compartilham o mesmo banco
 * e as mesmas filas, como em produção com réplicas.
 *
 * `kill("SIGKILL")` derruba sem handlers, sem flush e sem ack: é a queda que os cenários
 * do README §11 e §13 pedem. No Windows qualquer sinal encerra o processo à força.
 */
export class AppInstance {
  public readonly logLines: string[] = [];
  private exitCode: number | null | undefined;
  private readonly exited: Promise<number | null>;

  private constructor(
    public readonly name: string,
    public readonly port: number,
    private readonly proc: ReturnType<typeof Bun.spawn>,
  ) {
    this.exited = proc.exited.then((code) => {
      this.exitCode = code;
      return code;
    });
  }

  public get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  public get alive(): boolean {
    return this.exitCode === undefined;
  }

  /** Entradas de log já interpretadas como JSON (linhas que não são JSON viram `{ msg }`). */
  public logs(): LogEntry[] {
    return this.logLines.map((line) => {
      try {
        return JSON.parse(line) as LogEntry;
      } catch {
        return { msg: line };
      }
    });
  }

  /** Sobe a instância e só devolve quando `/health/ready` responde 200. */
  public static async start(options: AppInstanceOptions): Promise<AppInstance> {
    const port = await freePort();
    const roles = options.roles ?? {};
    const { db, queues } = options;

    const proc = Bun.spawn([process.execPath, "run", "src/main.ts"], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        NODE_ENV: "test",
        PORT: String(port),
        DATABASE_URL: db.url,
        DB_NAME: db.dbName,
        DB_POOL_MAX: String(options.poolMax ?? 10),
        AWS_ENDPOINT: TEST_SQS_ENDPOINT,
        AWS_ACCESS_KEY_ID: "dummy",
        AWS_SECRET_ACCESS_KEY: "dummy",
        SQS_QUEUE_WAGER_TRANSACTIONS: queues.transactionsQueueName,
        SQS_QUEUE_WAGER_TRANSACTIONS_DLQ: queues.dlqQueueName,
        SQS_QUEUE_WAGER_EVENTS: queues.eventsQueueName,
        SQS_MAX_RECEIVE_COUNT: String(queues.maxReceiveCount),
        // Backoff e long polling curtos: os testes terminam em segundos, não em minutos
        SQS_WAIT_SECONDS: "1",
        SQS_RETRY_BASE_SECONDS: "1",
        SQS_RETRY_MAX_SECONDS: "1",
        OUTBOX_POLL_INTERVAL_MS: "100",
        PENDING_WORKER_POLL_INTERVAL_MS: "200",
        SHUTDOWN_TIMEOUT_MS: "3000",
        ENABLE_SQS_CONSUMER: String(roles.sqsConsumer ?? false),
        ENABLE_OUTBOX_PUBLISHER: String(roles.outboxPublisher ?? false),
        ENABLE_PENDING_WORKER: String(roles.pendingWorker ?? false),
        ...options.env,
      },
    });

    const instance = new AppInstance(options.name, port, proc);
    instance.capture(proc.stdout as ReadableStream<Uint8Array>);
    instance.capture(proc.stderr as ReadableStream<Uint8Array>);

    try {
      await waitFor(
        async () => {
          if (!instance.alive) {
            throw new Error(`instance '${options.name}' exited during boot (code ${instance.exitCode})`);
          }
          return instance.isReady();
        },
        {
          timeoutMs: options.readyTimeoutMs ?? 30_000,
          intervalMs: 100,
          description: `instance '${options.name}' to become ready`,
        },
      );
    } catch (error) {
      await instance.kill("SIGKILL");
      throw new Error(`${(error as Error).message}\n--- logs ---\n${instance.logLines.slice(-30).join("\n")}`);
    }
    return instance;
  }

  /** `SIGKILL` para queda; `SIGTERM` para parada pedida. Espera o processo sair. */
  public async kill(signal: "SIGKILL" | "SIGTERM" = "SIGKILL"): Promise<void> {
    if (this.alive) {
      this.proc.kill(signal);
    }
    await this.exited;
  }

  /** Espera o processo morrer por conta própria (por exemplo, por uma falha injetada). */
  public async waitForExit(timeoutMs = 30_000): Promise<number | null> {
    await waitFor(() => !this.alive, {
      timeoutMs,
      description: `instance '${this.name}' to exit`,
    });
    return this.exitCode ?? null;
  }

  public async stop(): Promise<void> {
    await this.kill("SIGKILL");
  }

  private async isReady(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health/ready`);
      return response.status === 200;
    } catch {
      return false;
    }
  }

  private capture(stream: ReadableStream<Uint8Array>): void {
    const decoder = new TextDecoder();
    let pending = "";
    void (async () => {
      try {
        for await (const chunk of stream) {
          pending += decoder.decode(chunk, { stream: true });
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          for (const line of lines) {
            if (line.trim() !== "") {
              this.logLines.push(line);
            }
          }
        }
      } catch {
        // O processo foi morto no meio da leitura
      }
      if (pending.trim() !== "") {
        this.logLines.push(pending);
      }
    })();
  }
}

/** Sobe `count` instâncias em paralelo, todas com os mesmos papéis. */
export async function startInstances(
  count: number,
  options: Omit<AppInstanceOptions, "name">,
): Promise<AppInstance[]> {
  return Promise.all(
    Array.from({ length: count }, (_unused, index) =>
      AppInstance.start({ ...options, name: `app-${index + 1}` }),
    ),
  );
}

export async function stopAll(instances: AppInstance[]): Promise<void> {
  await Promise.all(instances.map((instance) => instance.stop()));
}

export interface HttpOutcome {
  status: number;
  body: {
    transactionId: string;
    status: string;
    failureCode?: string;
    balance: { amount: string; currency: string };
    idempotentReplay: boolean;
  };
}

/** `POST /wagering/transactions` contra uma instância, com `Idempotency-Key` do comando. */
export async function postWagerTransaction(
  baseUrl: string,
  command: SubmitWagerTransactionCommand,
): Promise<HttpOutcome> {
  const { idempotencyKey, money, ...business } = command;
  const response = await fetch(`${baseUrl}/wagering/transactions`, {
    method: "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ ...business, money: money.toJSON() }),
  });
  return { status: response.status, body: (await response.json()) as HttpOutcome["body"] };
}
