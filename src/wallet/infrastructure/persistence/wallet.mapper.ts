import { Money } from "../../../shared/domain/money";
import { toDate } from "../../../shared/infrastructure/persistence/timestamps";
import { Wallet } from "../../domain/wallet";
import type { WalletRow } from "./wallet.entity-schema";

export class WalletPersistenceMapper {
  /**
   * Converte uma entidade de domínio Wallet em sua representação relacional WalletRow.
   */
  public static toRow(domain: Wallet): WalletRow {
    return {
      id: domain.id,
      playerId: domain.playerId,
      currency: domain.currency,
      balance: domain.balance.amount,
      version: domain.version,
      createdAt: domain.createdAt,
      updatedAt: domain.updatedAt,
    };
  }

  /**
   * Reconstrói o agregado Wallet a partir da linha persistida utilizando a factory rehydrate.
   */
  public static toDomain(row: WalletRow): Wallet {
    const balance = Money.from({ amount: row.balance, currency: row.currency });
    return Wallet.rehydrate({
      id: row.id,
      playerId: row.playerId,
      currency: row.currency,
      balance,
      version: row.version,
      createdAt: toDate(row.createdAt),
      updatedAt: toDate(row.updatedAt),
    });
  }
}

