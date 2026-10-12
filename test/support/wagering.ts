import { randomBytes } from "node:crypto";
import { Money } from "../../src/shared/domain/money";
import { AppLogger } from "../../src/shared/infrastructure/observability/app-logger";
import { MetricsService } from "../../src/shared/infrastructure/observability/metrics.service";
import { CreateWalletUseCase } from "../../src/wallet/application/create-wallet.use-case";
import type { OutboxRepository } from "../../src/messaging/application/outbox.repository.port";
import type { LedgerRepository } from "../../src/wallet/application/ledger.repository.port";
import type { PendingReferencePolicy } from "../../src/wagering/application/pending-reference-policy";
import type { SubmitWagerTransactionCommand } from "../../src/wagering/application/submit-wager-transaction.command";
import { SubmitWagerTransactionUseCase } from "../../src/wagering/application/submit-wager-transaction.use-case";
import { WagerSettlementService } from "../../src/wagering/application/wager-settlement.service";
import { WagerTransactionKind } from "../../src/wagering/domain/wager-transaction-types";
import type { PersistenceTestContext } from "./persistence";

export const brl = (amount: string): Money => Money.from({ amount, currency: "BRL" });

export const TEST_PENDING_POLICY: PendingReferencePolicy = {
  baseDelayMs: 2000,
  maxDelayMs: 60_000,
  maxAttempts: 8,
};

export interface WalletFixture {
  walletId: string;
  playerId: string;
}

export interface WageringHarnessOverrides {
  /** Wrapper com falha injetada em volta do repositório real. */
  ledger?: LedgerRepository;
  outbox?: OutboxRepository;
}

/**
 * Monta o caso de uso sobre os repositórios reais (PostgreSQL) de um contexto de
 * persistência de teste. As sobreposições aceitam apenas wrappers em volta de componentes reais.
 */
export class WageringHarness {
  public readonly metrics = new MetricsService({ collectDefaults: false });
  public readonly logger = new AppLogger({ level: "silent" });
  public readonly settlement: WagerSettlementService;
  public readonly useCase: SubmitWagerTransactionUseCase;

  constructor(
    public readonly ctx: PersistenceTestContext,
    overrides: WageringHarnessOverrides = {},
  ) {
    this.settlement = new WagerSettlementService(
      ctx.walletRepo,
      ctx.transactionRepo,
      overrides.ledger ?? ctx.ledgerRepo,
      overrides.outbox ?? ctx.outboxRepo,
      ctx.idGenerator,
      TEST_PENDING_POLICY,
    );
    this.useCase = new SubmitWagerTransactionUseCase(
      ctx.unitOfWork,
      ctx.walletRepo,
      ctx.transactionRepo,
      ctx.inboxRepo,
      this.settlement,
      ctx.idGenerator,
      ctx.clock,
      this.logger,
      this.metrics,
    );
  }

  /** Cria uma wallet pelo caminho real (com `OPENING`, ledger e eventos). */
  public async createWallet(balance: string): Promise<WalletFixture> {
    const playerId = `player-${randomBytes(6).toString("hex")}`;
    const wallet = await new CreateWalletUseCase(
      this.ctx.unitOfWork,
      this.ctx.walletRepo,
      this.ctx.transactionRepo,
      this.ctx.ledgerRepo,
      this.ctx.outboxRepo,
      this.ctx.idGenerator,
      this.ctx.clock,
      this.logger,
      this.metrics,
    ).execute({ playerId, initialBalance: brl(balance) });
    return { walletId: wallet.id, playerId };
  }

  /** Comando com ids únicos; `amount` default `10.00 BRL`. */
  public command(
    wallet: WalletFixture,
    overrides: Partial<SubmitWagerTransactionCommand> = {},
  ): SubmitWagerTransactionCommand {
    const providerId = overrides.providerId ?? "provider-test";
    const externalTransactionId =
      overrides.externalTransactionId ?? `ext-${randomBytes(8).toString("hex")}`;
    return {
      idempotencyKey: `${providerId}:${externalTransactionId}`,
      providerId,
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.walletId,
      roundId: "round-1",
      gameId: "game-1",
      kind: WagerTransactionKind.Bet,
      money: brl("10.00"),
      ...overrides,
    };
  }
}
