import { describe, it, expect } from "bun:test";
import { MetricsService } from "../../../../src/shared/infrastructure/observability/metrics.service";
import {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../../../src/wagering/domain/wager-transaction-types";

describe("MetricsService", () => {
  it("exposes every instrument name even before any sample", async () => {
    const output = await new MetricsService({ collectDefaults: false }).render();

    for (const name of [
      "wager_transactions_total",
      "wager_duplicates_total",
      "wager_retries_total",
      "sqs_dlq_messages_total",
      "wallet_lock_conflicts_total",
      "outbox_lag_seconds",
      "outbox_published_total",
      "outbox_publish_failures_total",
      "wager_processing_duration_seconds",
      "reconciliation_divergences_total",
    ]) {
      expect(output).toContain(`# TYPE ${name} `);
    }
  });

  it("counts transactions by kind, status and failure code", async () => {
    const metrics = new MetricsService({ collectDefaults: false });
    metrics.recordTransaction(
      WagerTransactionKind.Bet,
      WagerTransactionStatus.Processed,
    );
    metrics.recordTransaction(
      WagerTransactionKind.Bet,
      WagerTransactionStatus.Rejected,
      FailureCode.InsufficientFunds,
    );
    metrics.recordTransaction(
      WagerTransactionKind.Bet,
      WagerTransactionStatus.Rejected,
      FailureCode.InsufficientFunds,
    );

    const output = await metrics.render();
    expect(output).toContain(
      'wager_transactions_total{kind="BET",status="PROCESSED",failure_code="NONE"} 1',
    );
    expect(output).toContain(
      'wager_transactions_total{kind="BET",status="REJECTED",failure_code="INSUFFICIENT_FUNDS"} 2',
    );
  });

  it("records duplicates, retries, DLQ and lock conflicts with their labels", async () => {
    const metrics = new MetricsService({ collectDefaults: false });
    metrics.recordDuplicate("http", "replay");
    metrics.recordDuplicate("sqs", "conflict");
    metrics.recordRetry("sqs", "transient_failure");
    metrics.recordDlqMessage("invalid_message");
    metrics.recordLockConflict("deadlock");

    const output = await metrics.render();
    expect(output).toContain('wager_duplicates_total{source="http",type="replay"} 1');
    expect(output).toContain('wager_duplicates_total{source="sqs",type="conflict"} 1');
    expect(output).toContain('wager_retries_total{source="sqs",reason="transient_failure"} 1');
    expect(output).toContain('sqs_dlq_messages_total{reason="invalid_message"} 1');
    expect(output).toContain('wallet_lock_conflicts_total{type="deadlock"} 1');
  });

  it("tracks outbox gauge and counters", async () => {
    const metrics = new MetricsService({ collectDefaults: false });
    metrics.setOutboxLagSeconds(12.5);
    metrics.recordOutboxPublished(3);
    metrics.recordOutboxPublishFailure();
    metrics.recordReconciliationDivergence();

    const output = await metrics.render();
    expect(output).toContain("outbox_lag_seconds 12.5");
    expect(output).toContain("outbox_published_total 3");
    expect(output).toContain("outbox_publish_failures_total 1");
    expect(output).toContain("reconciliation_divergences_total 1");
  });

  it("measures processing duration through the timer", async () => {
    const metrics = new MetricsService({ collectDefaults: false });
    const stop = metrics.startProcessingTimer("http");
    const seconds = stop("processed");

    expect(seconds).toBeGreaterThanOrEqual(0);
    const output = await metrics.render();
    expect(output).toContain(
      'wager_processing_duration_seconds_count{source="http",outcome="processed"} 1',
    );
  });

  it("keeps registries independent between instances", async () => {
    const a = new MetricsService({ collectDefaults: false });
    const b = new MetricsService({ collectDefaults: false });
    a.recordOutboxPublished();

    expect(await b.render()).toContain("outbox_published_total 0");
  });
});
