import { Inject } from "@nestjs/common";
import { TransactionNotFoundError } from "../../shared/domain/domain.error";
import type { WagerTransaction } from "../domain/wager-transaction";
import {
  WAGER_TRANSACTION_REPOSITORY_TOKEN,
  type WagerTransactionRepository,
} from "./wager-transaction.repository.port";

/** Consultas de leitura pura de uma transação; não tomam lock da wallet. */
export class GetWagerTransactionUseCase {
  constructor(
    @Inject(WAGER_TRANSACTION_REPOSITORY_TOKEN)
    private readonly transactions: WagerTransactionRepository,
  ) {}

  public async byId(transactionId: string): Promise<WagerTransaction> {
    const transaction = await this.transactions.findById(transactionId);
    if (!transaction) {
      throw new TransactionNotFoundError(transactionId);
    }
    return transaction;
  }

  public async byProviderReference(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction> {
    const transaction = await this.transactions.findByProviderAndExternalId(
      providerId,
      externalTransactionId,
    );
    if (!transaction) {
      throw new TransactionNotFoundError(`${providerId}/${externalTransactionId}`);
    }
    return transaction;
  }
}
