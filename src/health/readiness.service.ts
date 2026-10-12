import type { OnModuleDestroy } from "@nestjs/common";
import type { ReadinessCheck } from "../shared/application/readiness-check.port";
import type { AppLogger } from "../shared/infrastructure/observability/app-logger";

export type DependencyState = "up" | "down";

export interface ReadinessReport {
  ready: boolean;
  status: "ok" | "unavailable" | "shutting_down";
  /** Ausente durante o shutdown: as dependências nem são consultadas. */
  checks?: Record<string, DependencyState>;
}

/**
 * Decide se esta instância deve receber tráfego. As dependências são consultadas em
 * paralelo, cada uma com prazo curto: um banco travado não pode travar a própria sondagem.
 *
 * `onModuleDestroy` roda antes de qualquer `beforeApplicationShutdown`, inclusive o do
 * consumidor SQS que espera os handlers terminarem; assim o `ready` já responde 503 durante
 * toda a drenagem e o orquestrador tira a instância da rotação.
 */
export class ReadinessService implements OnModuleDestroy {
  private shuttingDown = false;

  constructor(
    private readonly checks: readonly ReadinessCheck[],
    private readonly logger: AppLogger,
    private readonly timeoutMs: number,
  ) {}

  public onModuleDestroy(): void {
    this.shuttingDown = true;
  }

  public async evaluate(): Promise<ReadinessReport> {
    if (this.shuttingDown) {
      return { ready: false, status: "shutting_down" };
    }

    const states = await Promise.all(this.checks.map((check) => this.run(check)));
    const checks: Record<string, DependencyState> = {};
    this.checks.forEach((check, index) => {
      checks[check.name] = states[index]!;
    });
    const ready = states.every((state) => state === "up");
    return { ready, status: ready ? "ok" : "unavailable", checks };
  }

  private async run(check: ReadinessCheck): Promise<DependencyState> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
    });

    try {
      await Promise.race([check.check(controller.signal), deadline]);
      return "up";
    } catch (error) {
      // O motivo fica só no log: a resposta HTTP não vaza host, porta nem mensagem do driver.
      this.logger.warn("readiness check failed", {
        dependency: check.name,
        error: error instanceof Error ? error.message : String(error),
      });
      return "down";
    } finally {
      clearTimeout(timer);
    }
  }
}
