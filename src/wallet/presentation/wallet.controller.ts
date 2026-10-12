import { Body, Controller, HttpCode, Inject, Post } from "@nestjs/common";
import type { MoneyProps } from "../../shared/domain/money";
import { ZodValidationPipe } from "../../shared/presentation/zod-validation.pipe";
import { CreateWalletUseCase } from "../application/create-wallet.use-case";
import { type CreateWalletBody, CreateWalletBodySchema } from "./create-wallet.request";

export interface CreateWalletResponse {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

@Controller("wallets")
export class WalletController {
  constructor(
    @Inject(CreateWalletUseCase) private readonly createWallet: CreateWalletUseCase,
  ) {}

  @Post()
  @HttpCode(201)
  public async create(
    @Body(new ZodValidationPipe(CreateWalletBodySchema)) body: CreateWalletBody,
  ): Promise<CreateWalletResponse> {
    const wallet = await this.createWallet.execute({
      playerId: body.playerId,
      initialBalance: body.initialBalance,
    });

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }
}
