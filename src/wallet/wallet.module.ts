import { Module } from "@nestjs/common";
import { CreateWalletUseCase } from "./application/create-wallet.use-case";
import { GetWalletUseCase } from "./application/get-wallet.use-case";
import { ListWalletLedgerUseCase } from "./application/list-wallet-ledger.use-case";
import { ReconcileWalletUseCase } from "./application/reconcile-wallet.use-case";
import { WalletController } from "./presentation/wallet.controller";

@Module({
  controllers: [WalletController],
  providers: [
    CreateWalletUseCase,
    GetWalletUseCase,
    ListWalletLedgerUseCase,
    ReconcileWalletUseCase,
  ],
})
export class WalletModule {}
