import { Inject } from "@nestjs/common";
import { ID_GENERATOR_TOKEN, type IdGenerator } from "../../shared/application/id-generator.port";
import { WalletNotFoundError } from "../../shared/domain/domain.error";
import { LEDGER_REPOSITORY_TOKEN, type LedgerRepository } from "../../wallet/application/ledger.repository.port";
import { WALLET_REPOSITORY_TOKEN, type WalletRepository } from "../../wallet/application/wallet.repository.port";
import type { Wallet } from "../../wallet/domain/wallet";
import { LedgerDirection } from "../../wallet/domain/wallet-ledger-entry";
import { SettlementPolicy, type SettlementDecision } from "../domain/settlement-policy";
import type { WagerTransaction } from "../domain/wager-transaction";
import {
  PENDING_REFERENCE_POLICY_TOKEN,
  type PendingReferencePolicy,
} from "./pending-reference-policy";
import {
  WAGER_TRANSACTION_REPOSITORY_TOKEN,
  type WagerTransactionRepository,
} from "./wager-transaction.repository.port";

/**
 * Liquida uma transação já persistida: trava a wallet, resolve a referência, decide
 * pela `SettlementPolicy` e aplica a decisão (saldo, ledger e estado da transação).
 *
 * Deve rodar dentro de um `UnitOfWork.run`. Toda escrita de saldo passa por
 * `findByIdForUpdate` + `updateBalance`: o lock de linha serializa as transações da
 * mesma wallet e a versão esperada é a segunda guarda.
 */
export class WagerSettlementService {
  constructor(
    @Inject(WALLET_REPOSITORY_TOKEN) private readonly wallets: WalletRepository,
    @Inject(WAGER_TRANSACTION_REPOSITORY_TOKEN) private readonly transactions: WagerTransactionRepository,
    @Inject(LEDGER_REPOSITORY_TOKEN) private readonly ledger: LedgerRepository,
    @Inject(ID_GENERATOR_TOKEN) private readonly ids: IdGenerator,
    @Inject(PENDING_REFERENCE_POLICY_TOKEN) private readonly pendingPolicy: PendingReferencePolicy,
  ) {}

  public async settle(transaction: WagerTransaction, now: Date): Promise<void> {
    // O lock vem antes de qualquer leitura que alimente a decisão: referência e
    // reversão existente são lidas já sob o lock da wallet.
    const wallet = await this.wallets.findByIdForUpdate(transaction.walletId);
    if (!wallet) {
      throw new WalletNotFoundError(transaction.walletId);
    }

    const reference = transaction.referenceExternalTransactionId
      ? await this.transactions.findByProviderAndExternalId(
          transaction.providerId,
          transaction.referenceExternalTransactionId,
        )
      : null;
    const existingReversal = reference ? await this.transactions.findReversalOf(reference.id) : null;

    const decision = SettlementPolicy.decide({
      transaction,
      wallet,
      reference: reference ?? undefined,
      existingReversal: existingReversal ?? undefined,
    });

    await this.apply(decision, transaction, wallet, reference, now);
  }

  private async apply(
    decision: SettlementDecision,
    transaction: WagerTransaction,
    wallet: Wallet,
    reference: WagerTransaction | null,
    now: Date,
  ): Promise<void> {
    switch (decision.type) {
      case "APPLY": {
        const expectedVersion = wallet.version;
        const operation = {
          entryId: this.ids.generate(),
          transactionId: transaction.id,
          money: decision.money,
          at: now,
        };
        const entry =
          decision.direction === LedgerDirection.Debit
            ? wallet.debit(operation)
            : wallet.credit(operation);
        await this.wallets.updateBalance(wallet, expectedVersion);
        await this.ledger.append(entry);
        transaction.markProcessed(reference?.id, wallet.balance, now);
        break;
      }
      case "NO_BALANCE_EFFECT":
        transaction.markProcessed(reference?.id, wallet.balance, now);
        break;
      case "REJECT":
        transaction.reject(decision.code, wallet.balance);
        break;
      case "PENDING_REFERENCE":
        transaction.markPendingReference(
          wallet.balance,
          new Date(now.getTime() + this.pendingPolicy.baseDelayMs),
        );
        break;
    }
    await this.transactions.save(transaction, now);
  }
}
