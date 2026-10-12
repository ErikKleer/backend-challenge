import { RequestValidationError } from "../../shared/presentation/request-validation.error";

export const DEFAULT_LEDGER_PAGE_SIZE = 50;
export const MAX_LEDGER_PAGE_SIZE = 200;

interface CursorPayload {
  v: 1;
  wv: number;
}

/**
 * Cursor opaco do ledger: base64url de `{ v: 1, wv: <último wallet_version> }`.
 * É estável porque `wallet_version` é imutável e estritamente crescente por wallet:
 * lançamentos novos só aparecem depois do cursor, e nenhum item é pulado ou repetido.
 * O campo `v` permite evoluir o formato sem quebrar cursores em circulação.
 */
export function encodeLedgerCursor(lastWalletVersion: number): string {
  const payload: CursorPayload = { v: 1, wv: lastWalletVersion };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** Devolve o `wallet_version` do cursor; qualquer defeito vira 400. */
export function decodeLedgerCursor(cursor: string): number {
  const invalid = (): never => {
    throw new RequestValidationError("cursor is invalid", [
      { path: "cursor", message: "must be a cursor returned by a previous response" },
    ]);
  };

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return invalid();
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    (payload as CursorPayload).v !== 1 ||
    !Number.isSafeInteger((payload as CursorPayload).wv) ||
    (payload as CursorPayload).wv < 0
  ) {
    return invalid();
  }
  return (payload as CursorPayload).wv;
}

/** `limit` da query string: inteiro em [1, 200]; ausente vale o padrão. */
export function parseLedgerLimit(raw: unknown): number {
  if (raw === undefined) {
    return DEFAULT_LEDGER_PAGE_SIZE;
  }
  if (typeof raw !== "string" || !/^[1-9]\d{0,5}$/.test(raw) || Number(raw) > MAX_LEDGER_PAGE_SIZE) {
    throw new RequestValidationError("limit is invalid", [
      { path: "limit", message: `must be an integer between 1 and ${MAX_LEDGER_PAGE_SIZE}` },
    ]);
  }
  return Number(raw);
}
