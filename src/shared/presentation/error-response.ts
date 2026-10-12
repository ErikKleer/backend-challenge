export interface ErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

/** Envelope de erro de todos os endpoints (contexto comum). */
export interface ErrorResponse {
  error: ErrorBody;
  correlationId: string;
}
