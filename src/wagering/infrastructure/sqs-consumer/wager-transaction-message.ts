import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson, computePayloadHash } from "../../domain/payload-hash";
import type { SubmitWagerTransactionCommand } from "../../application/submit-wager-transaction.command";
import {
  boundedText,
  refineWagerTransactionRules,
  wagerTransactionFields,
} from "../../presentation/submit-wager-transaction.request";

export const WAGER_TRANSACTION_REQUESTED = "WagerTransactionRequested";

/** Por que uma mensagem nunca poderá ser processada, não importa quantas vezes seja entregue. */
export type InvalidMessageReason = "invalid_json" | "invalid_envelope" | "unknown_type" | "invalid_data";

/**
 * Mensagem malformada: erro permanente. Vai para a DLQ sem retry, porque reentregá-la
 * só repetiria a mesma falha.
 */
export class InvalidWagerMessageError extends Error {
  constructor(
    public readonly reason: InvalidMessageReason,
    message: string,
  ) {
    super(message);
    this.name = "InvalidWagerMessageError";
  }
}

const EnvelopeSchema = z.object({
  messageId: boundedText("messageId", 255),
  type: z.string({ required_error: "type is required", invalid_type_error: "type must be a string" }),
  occurredAt: z.string().datetime({ message: "occurredAt must be an ISO-8601 timestamp" }),
  data: z.unknown(),
});

/**
 * `data` reaproveita os campos e as regras do POST /wagering/transactions; a chave de
 * idempotência, que no HTTP vem no header, viaja aqui dentro da mensagem.
 */
const DataSchema = z
  .object({ idempotencyKey: boundedText("idempotencyKey", 255), ...wagerTransactionFields })
  .superRefine(refineWagerTransactionRules);

export interface WagerTransactionMessage {
  /** Id de negócio da mensagem (`messageId` do envelope): chave de deduplicação da inbox. */
  messageId: string;
  occurredAt: Date;
  command: SubmitWagerTransactionCommand;
}

/**
 * Valida o corpo da mensagem em etapas (JSON, envelope, tipo, dados), para que o motivo
 * da recusa seja específico. O corpo traz dados financeiros e nunca vai inteiro para os
 * logs: o erro carrega só o motivo e o caminho dos campos inválidos.
 */
export function parseWagerTransactionMessage(body: string): WagerTransactionMessage {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new InvalidWagerMessageError("invalid_json", "Message body is not valid JSON");
  }

  const envelope = EnvelopeSchema.safeParse(json);
  if (!envelope.success) {
    throw new InvalidWagerMessageError("invalid_envelope", describeIssues(envelope.error));
  }
  if (envelope.data.type !== WAGER_TRANSACTION_REQUESTED) {
    throw new InvalidWagerMessageError(
      "unknown_type",
      `Unsupported message type '${envelope.data.type.slice(0, 64)}'`,
    );
  }

  const data = DataSchema.safeParse(envelope.data.data);
  if (!data.success) {
    throw new InvalidWagerMessageError("invalid_data", describeIssues(data.error));
  }

  return {
    messageId: envelope.data.messageId,
    occurredAt: new Date(envelope.data.occurredAt),
    command: data.data,
  };
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "body"}: ${issue.message}`)
    .join("; ");
}

/**
 * Hash da mensagem para a inbox: o conteúdo de negócio (o mesmo hash da transação) mais a
 * chave de idempotência. Cabeçalhos de transporte (`messageId`, `occurredAt`) ficam de fora,
 * então reenviar o mesmo pedido com outro `messageId` não é confundido com adulteração.
 */
export function hashMessageContent(command: SubmitWagerTransactionCommand): string {
  const businessHash = computePayloadHash({
    providerId: command.providerId,
    externalTransactionId: command.externalTransactionId,
    playerId: command.playerId,
    walletId: command.walletId,
    roundId: command.roundId,
    gameId: command.gameId,
    kind: command.kind,
    money: command.money,
    referenceExternalTransactionId: command.referenceExternalTransactionId,
  });
  return createHash("sha256")
    .update(canonicalJson({ idempotencyKey: command.idempotencyKey, businessHash }), "utf8")
    .digest("hex");
}
