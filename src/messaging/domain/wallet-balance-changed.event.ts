import { InvalidIntegrationEventError } from "../../shared/domain/domain.error";
import type { MoneyProps } from "../../shared/domain/money";
import type { Wallet } from "../../wallet/domain/wallet";
import type {
  LedgerDirection,
  WalletLedgerEntry,
} from "../../wallet/domain/wallet-ledger-entry";
import { deriveEventId } from "./event-id";
import { type EventContext, IntegrationEvent } from "./integration-event";

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

/**
 * Emitido **somente** quando o saldo muda (há lançamento no ledger). O consumidor ordena
 * por `walletVersion`, já que a ordem de entrega pode variar com vários publishers.
 */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  public readonly eventType = "WalletBalanceChanged";
  public readonly version = 1;

  public static from(
    wallet: Wallet,
    entry: WalletLedgerEntry,
    ctx: EventContext,
  ): WalletBalanceChanged {
    if (entry.walletId !== wallet.id) {
      throw new InvalidIntegrationEventError(
        `Ledger entry belongs to wallet '${entry.walletId}', not '${wallet.id}'`,
      );
    }

    return new WalletBalanceChanged({
      eventId: deriveEventId(entry.transactionId, "WalletBalanceChanged"),
      aggregateId: wallet.id,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.now,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: entry.walletVersion,
      },
    });
  }
}
