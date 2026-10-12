import type { OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import type { AppLogger } from "../../shared/infrastructure/observability/app-logger";
import type { OutboxBatchPublisher } from "./outbox-batch-publisher";

export interface OutboxPublisherWorkerOptions {
  /** Papel `ENABLE_OUTBOX_PUBLISHER`: com `false` o processo não publica nada. */
  enabled: boolean;
  pollIntervalMs: number;
  /** Para decidir se há mais trabalho imediato: lote cheio ⇒ roda de novo sem esperar. */
  batchSize: number;
}

/**
 * Laço contínuo de publicação da outbox. Um ciclo por vez (sem sobreposição dentro do
 * processo); a concorrência entre processos é resolvida pelo `SKIP LOCKED` do claim.
 *
 * Parada graciosa: `onModuleDestroy` impede novos ciclos, acorda a espera e aguarda o lote
 * em andamento terminar (commit incluído), para não deixar linhas publicadas sem marca.
 */
export class OutboxPublisherWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private stopping = false;
  private loop?: Promise<void>;
  private wake?: () => void;

  constructor(
    private readonly batchPublisher: OutboxBatchPublisher,
    private readonly logger: AppLogger,
    private readonly options: OutboxPublisherWorkerOptions,
  ) {}

  public onApplicationBootstrap(): void {
    this.start();
  }

  public async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  public start(): void {
    if (!this.options.enabled || this.loop) {
      return;
    }
    this.stopping = false;
    this.logger.info("outbox publisher started", {
      pollIntervalMs: this.options.pollIntervalMs,
      batchSize: this.options.batchSize,
    });
    this.loop = this.run();
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.loop;
    if (this.loop) {
      this.logger.info("outbox publisher stopped");
    }
    this.loop = undefined;
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      let claimed = 0;
      try {
        claimed = (await this.batchPublisher.runOnce()).claimed;
      } catch (error) {
        // Banco fora, deadlock etc.: o rollback devolveu as linhas; tenta de novo no próximo ciclo
        this.logger.error("outbox publish cycle failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // Lote cheio indica fila acumulada: continua sem esperar. Caso contrário, aguarda o intervalo
      const hasMoreWork = claimed >= this.options.batchSize;
      if (!hasMoreWork && !this.stopping) {
        await this.sleep(this.options.pollIntervalMs);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      this.wake = done;
      function done(): void {
        clearTimeout(timer);
        resolve();
      }
    });
  }
}
