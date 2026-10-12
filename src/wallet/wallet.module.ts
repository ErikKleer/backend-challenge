import { Module } from "@nestjs/common";
import { CreateWalletUseCase } from "./application/create-wallet.use-case";
import { WalletController } from "./presentation/wallet.controller";

@Module({
  controllers: [WalletController],
  providers: [CreateWalletUseCase],
})
export class WalletModule {}
