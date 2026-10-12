import { z } from "zod";
import { Money } from "../../shared/domain/money";
import { MoneyPropsSchema } from "../../shared/presentation/money-props.schema";
import { WagerTransactionKind } from "../domain/wager-transaction-types";

/** Tipos aceitos nas bordas: `OPENING` é interno e nunca entra por HTTP ou SQS. */
const SUBMITTABLE_KINDS = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
] as const;

export function boundedText(field: string, maxLength: number) {
  return z
    .string({
      required_error: `${field} is required`,
      invalid_type_error: `${field} must be a string`,
    })
    .max(maxLength, `${field} must have at most ${maxLength} characters`)
    .refine((value) => value.trim().length > 0, `${field} must not be empty`);
}

/**
 * Campos de negócio de uma transação, sem a chave de idempotência (no HTTP ela vem no
 * header; na mensagem SQS, em `data.idempotencyKey`). O consumidor SQS compõe este
 * shape e aplica as mesmas regras com `refineWagerTransactionRules`.
 */
export const wagerTransactionFields = {
  providerId: boundedText("providerId", 128),
  externalTransactionId: boundedText("externalTransactionId", 255),
  playerId: boundedText("playerId", 128),
  walletId: z
    .string({
      required_error: "walletId is required",
      invalid_type_error: "walletId must be a string",
    })
    .uuid("walletId must be a UUID"),
  roundId: boundedText("roundId", 128),
  gameId: boundedText("gameId", 128),
  kind: z.enum(SUBMITTABLE_KINDS, {
    errorMap: () => ({ message: `kind must be one of ${SUBMITTABLE_KINDS.join(", ")}` }),
  }),
  money: MoneyPropsSchema,
  referenceExternalTransactionId: boundedText("referenceExternalTransactionId", 255).optional(),
};

/** Regras que dependem de mais de um campo. */
export function refineWagerTransactionRules(
  value: {
    kind: WagerTransactionKind;
    money: Money;
    referenceExternalTransactionId?: string | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  const reverses =
    value.kind === WagerTransactionKind.Refund || value.kind === WagerTransactionKind.Rollback;
  if (reverses && value.referenceExternalTransactionId === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["referenceExternalTransactionId"],
      message: `referenceExternalTransactionId is required for ${value.kind}`,
    });
  }
  // Valor zero só faz sentido em LOSS, que não move saldo. Se o dinheiro era inválido, o
  // zod ainda chama esta regra (com `money` indefinido) e o problema já foi registrado.
  if (
    value.money instanceof Money &&
    value.kind !== WagerTransactionKind.Loss &&
    !value.money.isPositive()
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["money"],
      message: `money must be greater than zero for ${value.kind}`,
    });
  }
}

export const SubmitWagerTransactionBodySchema = z
  .object(wagerTransactionFields, {
    required_error: "Request body is required",
    invalid_type_error: "Request body must be a JSON object",
  })
  .superRefine(refineWagerTransactionRules);

export type SubmitWagerTransactionBody = z.output<typeof SubmitWagerTransactionBodySchema>;
