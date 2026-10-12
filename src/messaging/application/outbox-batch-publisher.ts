import type { Clock } from "../../shared/application/clock.port";
import type { UnitOfWork } from "../../shared/application/unit-of-work.port";
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
  public runOnce(): Promise<OutboxBatchResult> {
    const { unitOfWork, outbox, publisher, clock } = this.deps;

    return unitOfWork.run(async () => {
      const messages = await outbox.claimDue(clock.now(), this.options.batchSize);
      let published = 0;
      let failed = 0;

      for (const message of messages) {
        try {
          await publisher.publish(message);
        } catch {
          // Sem limite de tentativas: evento confirmado não se perde, só atrasa
          message.scheduleRetry(clock.now(), this.backoff);
          failed += 1;
          await outbox.save(message);
          continue;
        }
        message.markPublished(clock.now());
        published += 1;
        await outbox.save(message);
      }

      return { claimed: messages.length, published, failed };
    });
  }
}
