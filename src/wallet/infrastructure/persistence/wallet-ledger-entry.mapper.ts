import { Money } from "../../../shared/domain/money";
import { toDate } from "../../../shared/infrastructure/persistence/timestamps";
import { LedgerDirection, WalletLedgerEntry } from "../../domain/wallet-ledger-entry";
import type { WalletLedgerEntryRow } from "./wallet-ledger-entry.entity-schema";

export class WalletLedgerEntryPersistenceMapper {
  /**
   * Converte uma entidade de domínio WalletLedgerEntry em sua representação relacional.
   */
  public static toRow(domain: WalletLedgerEntry): WalletLedgerEntryRow {
    return {
      id: domain.id,
      walletId: domain.walletId,
      transactionId: domain.transactionId,
      direction: domain.direction,
      amount: domain.money.amount,
      currency: domain.money.currency,
      balanceBefore: domain.balanceBefore.amount,
      balanceAfter: domain.balanceAfter.amount,
      walletVersion: domain.walletVersion,
      createdAt: domain.createdAt,
    };
  }

  /**
   * Reconstrói a entidade WalletLedgerEntry a partir do registro do banco via rehydrate.
   */
  public static toDomain(row: WalletLedgerEntryRow): WalletLedgerEntry {
    const money = Money.from({ amount: row.amount, currency: row.currency });
    const balanceBefore = Money.from({ amount: row.balanceBefore, currency: row.currency });
    const balanceAfter = Money.from({ amount: row.balanceAfter, currency: row.currency });

    return WalletLedgerEntry.rehydrate({
      id: row.id,
      walletId: row.walletId,
      transactionId: row.transactionId,
      direction: row.direction as LedgerDirection,
      money,
      balanceBefore,
      balanceAfter,
      walletVersion: row.walletVersion,
      createdAt: toDate(row.createdAt),
    });
  }
}

