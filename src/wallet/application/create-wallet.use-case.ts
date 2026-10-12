import { Inject } from "@nestjs/common";
import { OUTBOX_REPOSITORY_TOKEN, type OutboxRepository } from "../../messaging/application/outbox.repository.port";
import { OutboxMessage } from "../../messaging/domain/outbox-message";
import { WagerTransactionProcessed } from "../../messaging/domain/wager-transaction-processed.event";
import { WalletBalanceChanged } from "../../messaging/domain/wallet-balance-changed.event";
import { CLOCK_TOKEN, type Clock } from "../../shared/application/clock.port";
import { ID_GENERATOR_TOKEN, type IdGenerator } from "../../shared/application/id-generator.port";
import { UNIT_OF_WORK_TOKEN, type UnitOfWork } from "../../shared/application/unit-of-work.port";
import { WalletAlreadyExistsError } from "../../shared/domain/domain.error";
import { Money } from "../../shared/domain/money";
import { AppLogger } from "../../shared/infrastructure/observability/app-logger";
import { bindContext, getContext } from "../../shared/infrastructure/observability/execution-context";
import { MetricsService } from "../../shared/infrastructure/observability/metrics.service";
import {
  WAGER_TRANSACTION_REPOSITORY_TOKEN,
  type WagerTransactionRepository,
} from "../../wagering/application/wager-transaction.repository.port";
import { computePayloadHash } from "../../wagering/domain/payload-hash";
import { WagerTransaction } from "../../wagering/domain/wager-transaction";
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../wagering/domain/wager-transaction-types";
import { Wallet } from "../domain/wallet";
import { LedgerDirection, WalletLedgerEntry } from "../domain/wallet-ledger-entry";
import { LEDGER_REPOSITORY_TOKEN, type LedgerRepository } from "./ledger.repository.port";
import { WALLET_REPOSITORY_TOKEN, type WalletRepository } from "./wallet.repository.port";

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: Money;
}

/** Identidade interna das transações `OPENING` (nunca vem de um provedor externo). */
export const OPENING_PROVIDER_ID = "internal";
export const OPENING_ROUND_AND_GAME_ID = "opening";

export function openingIdempotencyKey(walletId: string): string {
  return `opening:${walletId}`;
}

/**
 * Abre uma wallet. Se o saldo inicial for positivo, registra a transação interna
 * `OPENING` (já `PROCESSED`), o lançamento `CREDIT` e os eventos na outbox. Tudo no
 * mesmo `UnitOfWork.run`: ou a wallet nasce com sua contrapartida contábil, ou nada
 * é gravado.
 */
export class CreateWalletUseCase {
  constructor(
    @Inject(UNIT_OF_WORK_TOKEN) private readonly unitOfWork: UnitOfWork,
    @Inject(WALLET_REPOSITORY_TOKEN) private readonly wallets: WalletRepository,
    @Inject(WAGER_TRANSACTION_REPOSITORY_TOKEN) private readonly transactions: WagerTransactionRepository,
    @Inject(LEDGER_REPOSITORY_TOKEN) private readonly ledger: LedgerRepository,
    @Inject(OUTBOX_REPOSITORY_TOKEN) private readonly outbox: OutboxRepository,
    @Inject(ID_GENERATOR_TOKEN) private readonly ids: IdGenerator,
    @Inject(CLOCK_TOKEN) private readonly clock: Clock,
    @Inject(AppLogger) private readonly logger: AppLogger,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {}

  public async execute(command: CreateWalletCommand): Promise<Wallet> {
    const { wallet, openingTransactionId } = await this.unitOfWork.run(() => this.open(command));

    // Fora do run: só chega aqui depois do commit.
    this.logger.info("wallet created", {
      walletId: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      openingTransactionId,
    });
    if (openingTransactionId !== undefined) {
      this.metrics.recordTransaction(
        WagerTransactionKind.Opening,
        WagerTransactionStatus.Processed,
      );
    }
    return wallet;
  }

  private async open(
    command: CreateWalletCommand,
  ): Promise<{ wallet: Wallet; openingTransactionId?: string }> {
    const now = this.clock.now();
    const wallet = Wallet.open({
      id: this.ids.generate(),
      playerId: command.playerId,
      initialBalance: command.initialBalance,
      createdAt: now,
    });
    bindContext({ walletId: wallet.id });

    // Ordem imposta pelas FKs: wallet → transação → ledger.
    const inserted = await this.wallets.insertIfAbsent(wallet);
    if (!inserted) {
      throw new WalletAlreadyExistsError(wallet.playerId, wallet.currency);
    }

    if (!wallet.balance.isPositive()) {
      return { wallet };
    }

    const transaction = await this.recordOpening(wallet, now);
    return { wallet, openingTransactionId: transaction.id };
  }

  private async recordOpening(wallet: Wallet, now: Date): Promise<WagerTransaction> {
    const key = openingIdempotencyKey(wallet.id);
    const transaction = WagerTransaction.create({
      id: this.ids.generate(),
      providerId: OPENING_PROVIDER_ID,
      externalTransactionId: key,
      idempotencyKey: key,
      payloadHash: computePayloadHash({
        providerId: OPENING_PROVIDER_ID,
        externalTransactionId: key,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: OPENING_ROUND_AND_GAME_ID,
        gameId: OPENING_ROUND_AND_GAME_ID,
        kind: WagerTransactionKind.Opening,
        money: wallet.balance,
      }),
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: OPENING_ROUND_AND_GAME_ID,
      gameId: OPENING_ROUND_AND_GAME_ID,
      kind: WagerTransactionKind.Opening,
      money: wallet.balance,
      createdAt: now,
    });
    transaction.markProcessed(undefined, wallet.balance, now);
    bindContext({ transactionId: transaction.id });

    // O lançamento é montado à mão: `Wallet.credit` incrementaria a versão, mas a
    // wallet já nasce na versão 1 com o saldo inicial.
    const entry = WalletLedgerEntry.create({
      id: this.ids.generate(),
      walletId: wallet.id,
      transactionId: transaction.id,
      direction: LedgerDirection.Credit,
      money: wallet.balance,
      balanceBefore: Money.zero(wallet.currency),
      balanceAfter: wallet.balance,
      walletVersion: wallet.version,
      createdAt: now,
    });

    if (!(await this.transactions.insertIfAbsent(transaction))) {
      throw new Error(`Opening transaction for wallet '${wallet.id}' already exists`);
    }
    await this.ledger.append(entry);

    const context = {
      correlationId: getContext()?.correlationId ?? this.ids.generate(),
      now,
    };
    await this.outbox.enqueue(
      OutboxMessage.enqueue(WagerTransactionProcessed.from(transaction, context)),
    );
    await this.outbox.enqueue(
      OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, context)),
    );
    return transaction;
  }
}
