import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from "@nestjs/common";
import type { MoneyProps } from "../../shared/domain/money";
import { UuidParamPipe } from "../../shared/presentation/uuid-param.pipe";
import { ZodValidationPipe } from "../../shared/presentation/zod-validation.pipe";
import { CreateWalletUseCase } from "../application/create-wallet.use-case";
import { GetWalletUseCase } from "../application/get-wallet.use-case";
import { ListWalletLedgerUseCase } from "../application/list-wallet-ledger.use-case";
import { ReconcileWalletUseCase } from "../application/reconcile-wallet.use-case";
import { type CreateWalletBody, CreateWalletBodySchema } from "./create-wallet.request";
import { decodeLedgerCursor, encodeLedgerCursor, parseLedgerLimit } from "./ledger-cursor";

export interface CreateWalletResponse {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export interface LedgerEntryResponse {
  id: string;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
  createdAt: string;
}

export interface ReconciliationResponse {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

export interface LedgerPageResponse {
  items: LedgerEntryResponse[];
  nextCursor: string | null;
}

@Controller("wallets")
export class WalletController {
  constructor(
    @Inject(CreateWalletUseCase) private readonly createWallet: CreateWalletUseCase,
    @Inject(GetWalletUseCase) private readonly getWallet: GetWalletUseCase,
    @Inject(ListWalletLedgerUseCase) private readonly listLedger: ListWalletLedgerUseCase,
    @Inject(ReconcileWalletUseCase) private readonly reconcileWallet: ReconcileWalletUseCase,
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

  @Get(":walletId")
  public async get(
    @Param("walletId", new UuidParamPipe("walletId")) walletId: string,
  ): Promise<CreateWalletResponse> {
    const wallet = await this.getWallet.execute(walletId);
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }

  @Get(":walletId/ledger")
  public async ledger(
    @Param("walletId", new UuidParamPipe("walletId")) walletId: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ): Promise<LedgerPageResponse> {
    const afterVersion = cursor === undefined ? 0 : decodeLedgerCursor(cursor);
    const page = await this.listLedger.execute(walletId, afterVersion, parseLedgerLimit(limit));

    return {
      items: page.items.map((entry) => ({
        id: entry.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: entry.walletVersion,
        createdAt: entry.createdAt.toISOString(),
      })),
      nextCursor:
        page.nextAfterVersion === undefined ? null : encodeLedgerCursor(page.nextAfterVersion),
    };
  }

  @Post(":walletId/reconciliation")
  @HttpCode(200)
  public async reconcile(
    @Param("walletId", new UuidParamPipe("walletId")) walletId: string,
  ): Promise<ReconciliationResponse> {
    const result = await this.reconcileWallet.execute(walletId);
    return {
      walletId: result.walletId,
      storedBalance: result.storedBalance.toJSON(),
      calculatedBalance: result.calculatedBalance.toJSON(),
      difference: result.difference.toJSON(),
      consistent: result.consistent,
      checkedEntries: result.checkedEntries,
    };
  }
}
