import { Inject } from "@nestjs/common";
import { INBOX_REPOSITORY_TOKEN, type InboxRepository } from "../../messaging/application/inbox.repository.port";
import { InboxMessage } from "../../messaging/domain/inbox-message";
import { CLOCK_TOKEN, type Clock } from "../../shared/application/clock.port";
import { ID_GENERATOR_TOKEN, type IdGenerator } from "../../shared/application/id-generator.port";
import { UNIT_OF_WORK_TOKEN, type UnitOfWork } from "../../shared/application/unit-of-work.port";
import {
  IdempotencyConflictError,
  InboxPayloadMismatchError,
  InvalidTransactionStateError,
  WalletNotFoundError,
} from "../../shared/domain/domain.error";
import { AppLogger } from "../../shared/infrastructure/observability/app-logger";
import { bindContext, getContext } from "../../shared/infrastructure/observability/execution-context";
import {
  type LockConflictType,
  type MetricSource,
  MetricsService,
  type ProcessingOutcome,
} from "../../shared/infrastructure/observability/metrics.service";
import { TransientInfrastructureError } from "../../shared/infrastructure/persistence/postgres-errors";
import { WALLET_REPOSITORY_TOKEN, type WalletRepository } from "../../wallet/application/wallet.repository.port";
import { computePayloadHash } from "../domain/payload-hash";
import { WagerTransaction } from "../domain/wager-transaction";
import { WagerTransactionStatus } from "../domain/wager-transaction-types";
import type {
  SubmitWagerTransactionCommand,
  SubmitWagerTransactionOptions,
  SubmitWagerTransactionResult,
} from "./submit-wager-transaction.command";
import { WagerSettlementService } from "./wager-settlement.service";
import {
  WAGER_TRANSACTION_REPOSITORY_TOKEN,
  type WagerTransactionRepository,
} from "./wager-transaction.repository.port";

const LOCK_CONFLICT_BY_ERROR_CODE: Readonly<Record<string, LockConflictType>> = {
  LOCK_TIMEOUT: "lock_timeout",
  WALLET_VERSION_CONFLICT: "version_conflict",
  DEADLOCK_DETECTED: "deadlock",
};

const OUTCOME_BY_STATUS: Readonly<Partial<Record<WagerTransactionStatus, ProcessingOutcome>>> = {
  [WagerTransactionStatus.Processed]: "processed",
  [WagerTransactionStatus.Rejected]: "rejected",
  [WagerTransactionStatus.PendingReference]: "pending_reference",
};

/**
 * Caso de uso central, compartilhado por HTTP e SQS: submete uma transação de aposta
 * com idempotência persistente e a liquida sob lock da wallet.
 *
 * Tudo ocorre em um único `UnitOfWork.run`. A transação é inserida **antes** do lock:
 * o `UNIQUE` do banco decide a idempotência sem disputar a wallet (um replay nunca
 * espera o lock), e quem perde a corrida de inserção só lê o resultado já gravado.
 */
export class SubmitWagerTransactionUseCase {
  constructor(
    @Inject(UNIT_OF_WORK_TOKEN) private readonly unitOfWork: UnitOfWork,
    @Inject(WALLET_REPOSITORY_TOKEN) private readonly wallets: WalletRepository,
    @Inject(WAGER_TRANSACTION_REPOSITORY_TOKEN) private readonly transactions: WagerTransactionRepository,
    @Inject(INBOX_REPOSITORY_TOKEN) private readonly inbox: InboxRepository,
    @Inject(WagerSettlementService) private readonly settlement: WagerSettlementService,
    @Inject(ID_GENERATOR_TOKEN) private readonly ids: IdGenerator,
    @Inject(CLOCK_TOKEN) private readonly clock: Clock,
    @Inject(AppLogger) private readonly logger: AppLogger,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {}

  public async execute(
    command: SubmitWagerTransactionCommand,
    options: SubmitWagerTransactionOptions = {},
  ): Promise<SubmitWagerTransactionResult> {
    const source: MetricSource = options.inbox ? "sqs" : "http";
    const stopTimer = this.metrics.startProcessingTimer(source);
    bindContext({ walletId: command.walletId, providerId: command.providerId });

    try {
      return await this.unitOfWork.run(() => this.submit(command, options, source, stopTimer));
    } catch (error) {
      this.recordFailure(error, command, source, stopTimer);
      throw error;
    }
  }

  private async submit(
    command: SubmitWagerTransactionCommand,
    options: SubmitWagerTransactionOptions,
    source: MetricSource,
    stopTimer: (outcome: ProcessingOutcome) => number,
  ): Promise<SubmitWagerTransactionResult> {
    const now = this.clock.now();
    const payloadHash = computePayloadHash({
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      playerId: command.playerId,
      walletId: command.walletId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: command.money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
    });

    const inboxMessage = options.inbox
      ? InboxMessage.receive({ ...options.inbox, receivedAt: now })
      : undefined;
    if (inboxMessage && !(await this.inbox.tryReceive(inboxMessage))) {
      // Mensagem já recebida: o efeito já foi (ou está sendo) gravado, devolve-o sem reprocessar.
      // O mesmo messageId só é redelivery se o conteúdo for o mesmo
      const received = await this.inbox.find(inboxMessage.consumerName, inboxMessage.messageId);
      if (received && received.payloadHash !== inboxMessage.payloadHash) {
        throw new InboxPayloadMismatchError(inboxMessage.consumerName, inboxMessage.messageId);
      }
      const recorded = await this.transactions.findByIdempotencyKey(command.idempotencyKey);
      if (recorded) {
        return this.replay(recorded, payloadHash, command, source, stopTimer);
      }
    }

    if (!(await this.wallets.findById(command.walletId))) {
      throw new WalletNotFoundError(command.walletId);
    }

    const transaction = WagerTransaction.create({
      id: this.ids.generate(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: command.money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      createdAt: now,
    });

    if (!(await this.transactions.insertIfAbsent(transaction))) {
      // Outro messageId (ou o HTTP) já gravou esta operação: a mensagem nova também está tratada
      const replayed = await this.replayExisting(command, payloadHash, source, stopTimer);
      if (inboxMessage) {
        inboxMessage.markProcessed(now);
        await this.inbox.markProcessed(inboxMessage);
      }
      return replayed;
    }
    bindContext({ transactionId: transaction.id });

    await this.settlement.settle(transaction, {
      correlationId: getContext()?.correlationId ?? this.ids.generate(),
      causationId: options.inbox?.messageId,
      now,
    });

    if (inboxMessage) {
      inboxMessage.markProcessed(now);
      await this.inbox.markProcessed(inboxMessage);
    }

    const result = this.toResult(transaction, false);
    this.unitOfWork.afterCommit(() => {
      this.metrics.recordTransaction(transaction.kind, transaction.status, transaction.failureCode);
      this.finish(transaction, source, stopTimer, false);
    });
    return result;
  }

  /**
   * A inserção não gravou nada: a chave ou o par (provedor, id externo) já existe.
   * Mesma chave e mesmo hash é replay; qualquer outra combinação é conflito.
   */
  private async replayExisting(
    command: SubmitWagerTransactionCommand,
    payloadHash: string,
    source: MetricSource,
    stopTimer: (outcome: ProcessingOutcome) => number,
  ): Promise<SubmitWagerTransactionResult> {
    const byKey = await this.transactions.findByIdempotencyKey(command.idempotencyKey);
    if (byKey) {
      return this.replay(byKey, payloadHash, command, source, stopTimer);
    }

    const byNaturalId = await this.transactions.findByProviderAndExternalId(
      command.providerId,
      command.externalTransactionId,
    );
    if (byNaturalId) {
      throw new IdempotencyConflictError(
        `Transaction '${command.externalTransactionId}' of provider '${command.providerId}' was already submitted with a different idempotency key`,
      );
    }

    // Quem bloqueou a inserção desfez a transação entre o conflito e a leitura.
    throw new TransientInfrastructureError(
      "Conflicting transaction is no longer visible, retry the request",
      "IDEMPOTENT_ROW_NOT_VISIBLE",
    );
  }

  private replay(
    existing: WagerTransaction,
    payloadHash: string,
    command: SubmitWagerTransactionCommand,
    source: MetricSource,
    stopTimer: (outcome: ProcessingOutcome) => number,
  ): SubmitWagerTransactionResult {
    if (!existing.matchesPayload(payloadHash)) {
      throw new IdempotencyConflictError(
        `Idempotency key '${command.idempotencyKey}' was already used with a different payload`,
      );
    }
    if (existing.status === WagerTransactionStatus.Pending) {
      // Inserção e liquidação são uma transação só: PENDING visível indica estado anômalo.
      throw new TransientInfrastructureError(
        "Transaction is still being processed, retry the request",
        "TRANSACTION_IN_FLIGHT",
      );
    }

    bindContext({ transactionId: existing.id });
    const result = this.toResult(existing, true);
    this.unitOfWork.afterCommit(() => {
      this.metrics.recordDuplicate(source, "replay");
      this.finish(existing, source, stopTimer, true);
    });
    return result;
  }

  private toResult(transaction: WagerTransaction, idempotentReplay: boolean): SubmitWagerTransactionResult {
    if (!transaction.observedBalance) {
      throw new InvalidTransactionStateError(
        `Transaction '${transaction.id}' in status '${transaction.status}' has no observed balance`,
      );
    }
    return {
      transactionId: transaction.id,
      status: transaction.status,
      balance: transaction.observedBalance,
      ...(transaction.failureCode !== undefined ? { failureCode: transaction.failureCode } : {}),
      idempotentReplay,
    };
  }

  /** Uma linha de log por transação e a duração; só chamado depois do commit. */
  private finish(
    transaction: WagerTransaction,
    source: MetricSource,
    stopTimer: (outcome: ProcessingOutcome) => number,
    idempotentReplay: boolean,
  ): void {
    const outcome = idempotentReplay ? "replay" : (OUTCOME_BY_STATUS[transaction.status] ?? "error");
    const seconds = stopTimer(outcome);
    this.logger.info("wager transaction submitted", {
      transactionId: transaction.id,
      walletId: transaction.walletId,
      providerId: transaction.providerId,
      kind: transaction.kind,
      source,
      status: transaction.status,
      failureCode: transaction.failureCode,
      idempotentReplay,
      durationMs: Math.round(seconds * 1000),
    });
  }

  /** Falhas não passam pelo commit, então são contadas aqui, depois do rollback. */
  private recordFailure(
    error: unknown,
    command: SubmitWagerTransactionCommand,
    source: MetricSource,
    stopTimer: (outcome: ProcessingOutcome) => number,
  ): void {
    if (error instanceof IdempotencyConflictError) {
      this.metrics.recordDuplicate(source, "conflict");
      stopTimer("conflict");
      this.logger.warn("wager transaction idempotency conflict", {
        walletId: command.walletId,
        providerId: command.providerId,
        source,
      });
      return;
    }
    if (error instanceof TransientInfrastructureError) {
      const conflict = LOCK_CONFLICT_BY_ERROR_CODE[error.code];
      if (conflict) {
        this.metrics.recordLockConflict(conflict);
      }
      stopTimer("transient_failure");
      this.logger.warn("wager transaction failed transiently", {
        walletId: command.walletId,
        providerId: command.providerId,
        source,
        errorCode: error.code,
      });
      return;
    }
    stopTimer("error");
  }
}
