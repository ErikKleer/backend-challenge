import type { SubmitWagerTransactionResult } from "../application/submit-wager-transaction.command";
import { WagerTransactionStatus } from "../domain/wager-transaction-types";

/**
 * Status HTTP de um resultado de submissão (tabela do README §9 / ADR 18):
 * `PROCESSED` é 201 na primeira vez e 200 no replay; `PENDING_REFERENCE` é 202 (aceito,
 * aguardando a referência); `REJECTED` é 422 e permanece 422 no replay, para o provedor
 * nunca confundir rejeição de negócio com sucesso.
 */
export function httpStatusFor(result: SubmitWagerTransactionResult): number {
  switch (result.status) {
    case WagerTransactionStatus.Processed:
      return result.idempotentReplay ? 200 : 201;
    case WagerTransactionStatus.Rejected:
    case WagerTransactionStatus.Failed:
      return 422;
    case WagerTransactionStatus.PendingReference:
    case WagerTransactionStatus.Pending:
      return 202;
  }
}
