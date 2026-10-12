import {
  Counter,
  collectDefaultMetrics,
  Gauge,
  Histogram,
  Registry,
} from "prom-client";
import type {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../../wagering/domain/wager-transaction-types";

// ---- Valores fechados dos rótulos
// Rótulos de baixa cardinalidade: nunca walletId, transactionId ou valores.

/** Canal de entrada da operação. */
export type MetricSource = "http" | "sqs" | "pending_worker";

/** `replay`: mesma key e mesmo hash; `conflict`: mesma key com hash diferente. */
export type DuplicateType = "replay" | "conflict";

export type RetryReason =
  | "transient_failure"
  | "pending_reference"
  | "redelivery";

export type DlqReason =
  | "invalid_message"
  | "max_receive_count"
  | "permanent_failure";

export type LockConflictType = "lock_timeout" | "version_conflict" | "deadlock";

export type ProcessingOutcome =
  | "processed"
  | "rejected"
  | "pending_reference"
  | "replay"
  | "conflict"
  | "transient_failure"
  | "error";

const NO_FAILURE = "NONE";

/**
 * Único ponto de instrumentação do serviço: todos os instrumentos são
 * declarados aqui, num registry próprio (não o global do prom-client), e os
 * demais módulos só chamam os métodos tipados.
 */
export class MetricsService {
  public readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: "wager_transactions_total",
    help: "Wager transactions by kind, resulting status and failure code.",
    labelNames: ["kind", "status", "failure_code"] as const,
    registers: [this.registry],
  });

  private readonly duplicates = new Counter({
    name: "wager_duplicates_total",
    help: "Duplicate submissions detected, by source and type.",
    labelNames: ["source", "type"] as const,
    registers: [this.registry],
  });

  private readonly retries = new Counter({
    name: "wager_retries_total",
    help: "Retries scheduled or observed, by source and reason.",
    labelNames: ["source", "reason"] as const,
    registers: [this.registry],
  });

  private readonly dlqMessages = new Counter({
    name: "sqs_dlq_messages_total",
    help: "Messages sent to the dead-letter queue, by reason.",
    labelNames: ["reason"] as const,
    registers: [this.registry],
  });

  private readonly lockConflicts = new Counter({
    name: "wallet_lock_conflicts_total",
    help: "Wallet concurrency conflicts, by type.",
    labelNames: ["type"] as const,
    registers: [this.registry],
  });

  private readonly outboxLag = new Gauge({
    name: "outbox_lag_seconds",
    help: "Age in seconds of the oldest pending outbox event (0 when empty).",
    registers: [this.registry],
  });

  private readonly outboxPublished = new Counter({
    name: "outbox_published_total",
    help: "Outbox events published to the broker.",
    registers: [this.registry],
  });

  private readonly outboxPublishFailures = new Counter({
    name: "outbox_publish_failures_total",
    help: "Failed attempts to publish an outbox event.",
    registers: [this.registry],
  });

  private readonly processingDuration = new Histogram({
    name: "wager_processing_duration_seconds",
    help: "End-to-end processing latency of a wager operation.",
    labelNames: ["source", "outcome"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });

  private readonly reconciliationDivergences = new Counter({
    name: "reconciliation_divergences_total",
    help: "Wallets whose balance diverged from the ledger-rebuilt balance.",
    registers: [this.registry],
  });

  constructor(options: { collectDefaults?: boolean } = {}) {
    if (options.collectDefaults ?? true) {
      collectDefaultMetrics({ register: this.registry });
    }
  }

  // ---- Instrumentos de negócio

  public recordTransaction(
    kind: WagerTransactionKind,
    status: WagerTransactionStatus,
    failureCode?: FailureCode,
  ): void {
    this.transactions.inc({
      kind,
      status,
      failure_code: failureCode ?? NO_FAILURE,
    });
  }

  public recordDuplicate(source: MetricSource, type: DuplicateType): void {
    this.duplicates.inc({ source, type });
  }

  public recordRetry(source: MetricSource, reason: RetryReason): void {
    this.retries.inc({ source, reason });
  }

  public recordDlqMessage(reason: DlqReason): void {
    this.dlqMessages.inc({ reason });
  }

  public recordLockConflict(type: LockConflictType): void {
    this.lockConflicts.inc({ type });
  }

  // ---- Outbox

  public setOutboxLagSeconds(seconds: number): void {
    this.outboxLag.set(seconds);
  }

  public recordOutboxPublished(count = 1): void {
    this.outboxPublished.inc(count);
  }

  public recordOutboxPublishFailure(count = 1): void {
    this.outboxPublishFailures.inc(count);
  }

  // ---- Latência e reconciliação

  public observeProcessingDuration(
    source: MetricSource,
    outcome: ProcessingOutcome,
    seconds: number,
  ): void {
    this.processingDuration.observe({ source, outcome }, seconds);
  }

  /**
   * Inicia a medição de uma operação; chamar a função devolvida com o
   * desfecho registra a duração e a retorna em segundos.
   */
  public startProcessingTimer(
    source: MetricSource,
  ): (outcome: ProcessingOutcome) => number {
    const startedAt = process.hrtime.bigint();
    return (outcome) => {
      const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
      this.observeProcessingDuration(source, outcome, seconds);
      return seconds;
    };
  }

  public recordReconciliationDivergence(count = 1): void {
    this.reconciliationDivergences.inc(count);
  }

  // ---- Exposição

  public contentType(): string {
    return this.registry.contentType;
  }

  public render(): Promise<string> {
    return this.registry.metrics();
  }
}
