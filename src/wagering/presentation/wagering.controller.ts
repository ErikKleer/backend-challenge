import { Body, Controller, HttpCode, Inject, Post } from "@nestjs/common";
import type { MoneyProps } from "../../shared/domain/money";
import { ZodValidationPipe } from "../../shared/presentation/zod-validation.pipe";
import { SubmitWagerTransactionUseCase } from "../application/submit-wager-transaction.use-case";
import type { FailureCode, WagerTransactionStatus } from "../domain/wager-transaction-types";
import { IdempotencyKey } from "./idempotency-key.pipe";
import {
  type SubmitWagerTransactionBody,
  SubmitWagerTransactionBodySchema,
} from "./submit-wager-transaction.request";

export interface SubmitWagerTransactionResponse {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: FailureCode;
}

@Controller("wagering/transactions")
export class WageringController {
  constructor(
    @Inject(SubmitWagerTransactionUseCase)
    private readonly submitTransaction: SubmitWagerTransactionUseCase,
  ) {}

  @Post()
  @HttpCode(201)
  public async submit(
    @IdempotencyKey() idempotencyKey: string,
    @Body(new ZodValidationPipe(SubmitWagerTransactionBodySchema)) body: SubmitWagerTransactionBody,
  ): Promise<SubmitWagerTransactionResponse> {
    const result = await this.submitTransaction.execute({ idempotencyKey, ...body });

    return {
      transactionId: result.transactionId,
      status: result.status,
      balance: result.balance.toJSON(),
      idempotentReplay: result.idempotentReplay,
      ...(result.failureCode !== undefined ? { failureCode: result.failureCode } : {}),
    };
  }
}
