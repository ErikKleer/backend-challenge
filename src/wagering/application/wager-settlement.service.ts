import { Inject } from "@nestjs/common";
import { OUTBOX_REPOSITORY_TOKEN, type OutboxRepository } from "../../messaging/application/outbox.repository.port";
import type { EventContext } from "../../messaging/domain/integration-event";
import { OutboxMessage } from "../../messaging/domain/outbox-message";
import { WagerTransactionPendingReference } from "../../messaging/domain/wager-transaction-pending-reference.event";
import { WagerTransactionProcessed } from "../../messaging/domain/wager-transaction-processed.event";
import { WagerTransactionRejected } from "../../messaging/domain/wager-transaction-rejected.event";
import { WalletBalanceChanged } from "../../messaging/domain/wallet-balance-changed.event";
import { ID_GENERATOR_TOKEN, type IdGenerator } from "../../shared/application/id-generator.port";
import { WalletNotFoundError } from "../../shared/domain/domain.error";
import { LEDGER_REPOSITORY_TOKEN, type LedgerRepository } from "../../wallet/application/ledger.repository.port";
import { WALLET_REPOSITORY_TOKEN, type WalletRepository } from "../../wallet/application/wallet.repository.port";
import type { Wallet } from "../../wallet/domain/wallet";
import { LedgerDirection, type WalletLedgerEntry } from "../../wallet/domain/wallet-ledger-entry";
import { SettlementPolicy, type SettlementDecision } from "../domain/settlement-policy";
import type { WagerTransaction } from "../domain/wager-transaction";
import { WagerTransactionStatus } from "../domain/wager-transaction-types";
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
 * pela `SettlementPolicy`, aplica a decisão (saldo, ledger e estado da transação) e
 * enfileira os eventos de integração na outbox.
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
    @Inject(OUTBOX_REPOSITORY_TOKEN) private readonly outbox: OutboxRepository,
    @Inject(ID_GENERATOR_TOKEN) private readonly ids: IdGenerator,
    @Inject(PENDING_REFERENCE_POLICY_TOKEN) private readonly pendingPolicy: PendingReferencePolicy,
  ) {}

  public async settle(transaction: WagerTransaction, context: EventContext): Promise<void> {
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

    const entry = await this.apply(decision, transaction, wallet, reference, context.now);
    await this.enqueueEvents(transaction, wallet, entry, context);
  }

  private async apply(
    decision: SettlementDecision,
    transaction: WagerTransaction,
    wallet: Wallet,
    reference: WagerTransaction | null,
    now: Date,
  ): Promise<WalletLedgerEntry | undefined> {
    let entry: WalletLedgerEntry | undefined;
    switch (decision.type) {
      case "APPLY": {
        const expectedVersion = wallet.version;
        const operation = {
          entryId: this.ids.generate(),
          transactionId: transaction.id,
          money: decision.money,
          at: now,
        };
        entry =
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
        if (transaction.status === WagerTransactionStatus.PendingReference) {
          // Reprocessamento: a referência ainda não está resolvida, recua o backoff
          const attempts = transaction.referenceAttempts + 1;
          transaction.scheduleReferenceRetry(new Date(now.getTime() + this.backoffDelayMs(attempts)));
        } else {
          transaction.markPendingReference(
            wallet.balance,
            new Date(now.getTime() + this.pendingPolicy.baseDelayMs),
          );
        }
        break;
    }
    await this.transactions.save(transaction, now);
    return entry;
  }

  /** `min(base × 2^tentativas, teto)`; a primeira espera (tentativa 0) é a própria base. */
  private backoffDelayMs(attempts: number): number {
    const { baseDelayMs, maxDelayMs } = this.pendingPolicy;
    return Math.min(baseDelayMs * 2 ** attempts, maxDelayMs);
  }

  /**
   * Os eventos entram na outbox na mesma transação SQL do efeito financeiro: se o
   * commit falhar, nenhum evento existe. O `WalletBalanceChanged` só sai quando houve
   * lançamento, isto é, quando o saldo de fato mudou.
   */
  private async enqueueEvents(
    transaction: WagerTransaction,
    wallet: Wallet,
    entry: WalletLedgerEntry | undefined,
    context: EventContext,
  ): Promise<void> {
    switch (transaction.status) {
      case WagerTransactionStatus.Processed:
        await this.outbox.enqueue(
          OutboxMessage.enqueue(WagerTransactionProcessed.from(transaction, context)),
        );
        if (entry) {
          await this.outbox.enqueue(
            OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, context)),
          );
        }
        break;
      case WagerTransactionStatus.Rejected:
        await this.outbox.enqueue(
          OutboxMessage.enqueue(WagerTransactionRejected.from(transaction, context)),
        );
        break;
      case WagerTransactionStatus.PendingReference:
        // O aviso de espera já saiu na primeira vez; tentativas seguintes não repetem o evento
        if (transaction.referenceAttempts > 0) {
          break;
        }
        await this.outbox.enqueue(
          OutboxMessage.enqueue(WagerTransactionPendingReference.from(transaction, context)),
        );
        break;
    }
  }
}
