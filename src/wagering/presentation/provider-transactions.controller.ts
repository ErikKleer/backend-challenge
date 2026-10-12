import { Controller, Get, Inject, Param } from "@nestjs/common";
import { RequestValidationError } from "../../shared/presentation/request-validation.error";
import { GetWagerTransactionUseCase } from "../application/get-wager-transaction.use-case";
import { toWagerTransactionView, type WagerTransactionView } from "./wager-transaction.view";

const MAX_PROVIDER_ID_LENGTH = 128;
const MAX_EXTERNAL_TRANSACTION_ID_LENGTH = 255;

function requireText(name: string, value: string, maxLength: number): string {
  if (value.trim().length === 0 || value.length > maxLength) {
    throw new RequestValidationError(`${name} is invalid`, [
      { path: name, message: `must be a non-empty string with up to ${maxLength} characters` },
    ]);
  }
  return value;
}

/** Consulta pela identidade do provedor: o par `(providerId, externalTransactionId)`. */
@Controller("providers/:providerId/wagering/transactions")
export class ProviderTransactionsController {
  constructor(
    @Inject(GetWagerTransactionUseCase) private readonly getTransaction: GetWagerTransactionUseCase,
  ) {}

  @Get(":externalTransactionId")
  public async get(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ): Promise<WagerTransactionView> {
    const transaction = await this.getTransaction.byProviderReference(
      requireText("providerId", providerId, MAX_PROVIDER_ID_LENGTH),
      requireText("externalTransactionId", externalTransactionId, MAX_EXTERNAL_TRANSACTION_ID_LENGTH),
    );
    return toWagerTransactionView(transaction);
  }
}
