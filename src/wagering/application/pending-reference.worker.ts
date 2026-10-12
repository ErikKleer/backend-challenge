import type { OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import type { AppLogger } from "../../shared/infrastructure/observability/app-logger";
import type { PendingReferenceReprocessor } from "./pending-reference.reprocessor";

export interface PendingReferenceWorkerOptions {
  /** Papel `ENABLE_PENDING_WORKER`: com `false` o processo não reprocessa nada. */
  enabled: boolean;
  pollIntervalMs: number;
  /** Lote cheio ⇒ ainda há vencidas, roda de novo sem esperar. */
  batchSize: number;
}

/**
 * Laço contínuo de reprocessamento de referências pendentes. Um ciclo por vez dentro do
 * processo; entre processos, o `SKIP LOCKED` do claim garante que cada transação vencida
 * é tratada por um worker só. A parada é graciosa: aguarda a transação em curso terminar.
 */
export class PendingReferenceWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private stopping = false;
  private loop?: Promise<void>;
  private wake?: () => void;

  constructor(
    private readonly reprocessor: PendingReferenceReprocessor,
    private readonly logger: AppLogger,
    private readonly options: PendingReferenceWorkerOptions,
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
    this.logger.info("pending reference worker started", {
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
      this.logger.info("pending reference worker stopped");
    }
    this.loop = undefined;
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      let claimed = 0;
      try {
        claimed = (await this.reprocessor.runOnce()).claimed;
      } catch (error) {
        // Lock timeout, banco fora etc.: a transação em curso deu rollback e segue vencida
        this.logger.error("pending reference cycle failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }

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
