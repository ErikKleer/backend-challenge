import type { Clock } from "../../shared/application/clock.port";
import { type FaultInjector, FaultPoint, NOOP_FAULT_INJECTOR } from "../../shared/application/fault-injector.port";
import type { UnitOfWork } from "../../shared/application/unit-of-work.port";
import type { AppLogger } from "../../shared/infrastructure/observability/app-logger";
import type { MetricsService } from "../../shared/infrastructure/observability/metrics.service";
import { DEFAULT_OUTBOX_BACKOFF, type OutboxBackoffPolicy } from "../domain/outbox-message";
import type { EventPublisher } from "./event-publisher.port";
import type { OutboxRepository } from "./outbox.repository.port";

export interface OutboxBatchPublisherOptions {
  batchSize: number;
  backoff?: OutboxBackoffPolicy;
}

export interface OutboxBatchResult {
  claimed: number;
  published: number;
  failed: number;
}

export interface OutboxBatchPublisherDependencies {
  unitOfWork: UnitOfWork;
  outbox: OutboxRepository;
  publisher: EventPublisher;
  clock: Clock;
  metrics: MetricsService;
  logger: AppLogger;
  /** Pontos de falha de teste; ausente = no-op. */
  faults?: FaultInjector;
}

interface PublishFailure {
  eventId: string;
  error: string;
}

/**
 * Um ciclo de publicação da outbox, numa única transação:
 *
 *   claimDue (FOR UPDATE SKIP LOCKED) → publish de cada mensagem → markPublished | scheduleRetry → commit
 *
 * Só linhas já commitadas são lidas, então nenhum evento sai antes da transação financeira
 * que o originou (README §5.4).
 *
 * **Trade-off:** a transação (e o lock das linhas) fica aberta durante as chamadas de rede.
 * O custo é limitado por lote pequeno (`OUTBOX_BATCH_SIZE`) e timeout curto no cliente SQS,
 * e a alternativa (marcar como "em publicação" e commitar antes de enviar) exigiria um
 * estado intermediário com lease e recuperação de linhas órfãs. Em troca, se o processo
 * morre no meio, o Postgres solta os locks e outra instância reclama as linhas sozinha.
 *
 * **Garantia:** *at-least-once*. Morrer entre o `publish` e o commit deixa a linha pendente,
 * e o próximo publisher a envia de novo; o consumidor deduplica por `eventId`.
 *
 * **Ordem:** não é garantida por agregado quando há vários publishers (cada um publica um
 * subconjunto); o consumidor ordena por `walletVersion`.
 */
export class OutboxBatchPublisher {
  private readonly backoff: OutboxBackoffPolicy;

  constructor(
    private readonly deps: OutboxBatchPublisherDependencies,
    private readonly options: OutboxBatchPublisherOptions,
  ) {
    this.backoff = options.backoff ?? DEFAULT_OUTBOX_BACKOFF;
  }

  /**
   * Executa um ciclo. A falha de uma mensagem agenda o retry dela e **não** desfaz a marcação
   * das que deram certo; uma falha de banco (claim/save/commit) rejeita o ciclo inteiro e o
   * rollback devolve todas as linhas ao pool de pendentes.
   */
  public async runOnce(): Promise<OutboxBatchResult> {
    const { unitOfWork, outbox, publisher, clock } = this.deps;
    const publishedIds: string[] = [];
    const failures: PublishFailure[] = [];

    const claimed = await unitOfWork.run(async () => {
      // Reinicia a cada tentativa da transação para não contar de um ciclo que deu rollback
      publishedIds.length = 0;
      failures.length = 0;
      const messages = await outbox.claimDue(clock.now(), this.options.batchSize);

      for (const message of messages) {
        try {
          await publisher.publish(message);
        } catch (error) {
          // Sem limite de tentativas: evento confirmado não se perde, só atrasa
          message.scheduleRetry(clock.now(), this.backoff);
          failures.push({ eventId: message.id, error: errorMessage(error) });
          await outbox.save(message);
          continue;
        }
        message.markPublished(clock.now());
        publishedIds.push(message.id);
        await outbox.save(message);
      }

      if (publishedIds.length > 0) {
        // Só em teste: eventos já no SQS, linhas ainda sem marca e a transação sem commit
        (this.deps.faults ?? NOOP_FAULT_INJECTOR).reach(FaultPoint.AfterPublishBeforeCommit);
      }

      return messages.length;
    });

    // Métricas e logs só depois do commit: refletem o que ficou gravado, não um lote revertido
    this.report(claimed, publishedIds, failures);
    await this.refreshLag();

    return { claimed, published: publishedIds.length, failed: failures.length };
  }

  private report(claimed: number, publishedIds: string[], failures: PublishFailure[]): void {
    const { metrics, logger } = this.deps;
    if (claimed === 0) {
      return;
    }
    metrics.recordOutboxPublished(publishedIds.length);
    metrics.recordOutboxPublishFailure(failures.length);

    // Só identificadores e contagens: o payload financeiro nunca vai para o log
    const fields = {
      claimed,
      published: publishedIds.length,
      failed: failures.length,
      publishedEventIds: publishedIds,
      failures,
    };
    if (failures.length > 0) {
      logger.warn("outbox batch finished with failures", fields);
    } else {
      logger.info("outbox batch published", fields);
    }
  }

  /**
   * Atualiza `outbox_lag_seconds` a cada ciclo, inclusive os vazios (é assim que o gauge
   * volta a 0). Uma falha aqui não pode derrubar a publicação: só perde a amostra.
   */
  private async refreshLag(): Promise<void> {
    const { unitOfWork, outbox, clock, metrics, logger } = this.deps;
    try {
      const oldest = await unitOfWork.run(() => outbox.oldestPendingOccurredAt());
      const lagMs = oldest === undefined ? 0 : clock.now().getTime() - oldest.getTime();
      metrics.setOutboxLagSeconds(Math.max(0, lagMs) / 1000);
    } catch (error) {
      logger.warn("outbox lag could not be measured", { error: errorMessage(error) });
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
