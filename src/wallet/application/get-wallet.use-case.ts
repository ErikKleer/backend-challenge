import { Inject } from "@nestjs/common";
import { WalletNotFoundError } from "../../shared/domain/domain.error";
import type { Wallet } from "../domain/wallet";
import { WALLET_REPOSITORY_TOKEN, type WalletRepository } from "./wallet.repository.port";

/** Consulta de leitura pura: sem lock e fora de qualquer transação de escrita. */
export class GetWalletUseCase {
  constructor(@Inject(WALLET_REPOSITORY_TOKEN) private readonly wallets: WalletRepository) {}

  public async execute(walletId: string): Promise<Wallet> {
    const wallet = await this.wallets.findById(walletId);
    if (!wallet) {
      throw new WalletNotFoundError(walletId);
    }
    return wallet;
  }
}
