import { Inject } from "@nestjs/common";
import { WalletNotFoundError } from "../../shared/domain/domain.error";
import type { WalletLedgerEntry } from "../domain/wallet-ledger-entry";
import { LEDGER_REPOSITORY_TOKEN, type LedgerRepository } from "./ledger.repository.port";
import { WALLET_REPOSITORY_TOKEN, type WalletRepository } from "./wallet.repository.port";

export interface LedgerPage {
  items: WalletLedgerEntry[];
  /** `wallet_version` do último item quando há mais páginas; ausente no fim. */
  nextAfterVersion?: number;
}

/**
 * Página do ledger em ordem de `wallet_version`. Lê `limit + 1` linhas: a sobra só
 * indica que há próxima página e é descartada, sem `COUNT` nem `OFFSET`.
 */
export class ListWalletLedgerUseCase {
  constructor(
    @Inject(WALLET_REPOSITORY_TOKEN) private readonly wallets: WalletRepository,
    @Inject(LEDGER_REPOSITORY_TOKEN) private readonly ledger: LedgerRepository,
  ) {}

  public async execute(walletId: string, afterVersion: number, limit: number): Promise<LedgerPage> {
    if (!(await this.wallets.findById(walletId))) {
      throw new WalletNotFoundError(walletId);
    }

    const rows = await this.ledger.findPage(walletId, afterVersion, limit + 1);
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return rows.length > limit && last
      ? { items, nextAfterVersion: last.walletVersion }
      : { items };
  }
}
