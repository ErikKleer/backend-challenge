import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Identificadores de correlação da execução corrente (requisição HTTP ou
 * mensagem SQS). Só carrega identificadores: nunca valores monetários nem
 * payloads.
 */
export interface ExecutionContext {
  correlationId: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

export type ExecutionContextExtras = Partial<ExecutionContext>;

const storage = new AsyncLocalStorage<ExecutionContext>();

/**
 * Executa `fn` com `context` visível a toda a cadeia assíncrona iniciada
 * dentro dela (`await`, `Promise.all`, timers). O objeto é copiado para que
 * `bindContext` não altere o argumento do chamador.
 */
export function runWithContext<T>(context: ExecutionContext, fn: () => T): T {
  return storage.run({ ...context }, fn);
}

/**
 * Enriquece o contexto corrente (por exemplo, com `walletId` depois de
 * carregar a wallet). Valores `undefined` são ignorados para não apagar o que
 * já foi vinculado. Fora de um contexto é um no-op.
 *
 * O contexto é compartilhado por toda a execução: ramos de um `Promise.all`
 * que precisem de identificadores próprios devem abrir um `runWithContext`
 * aninhado em vez de chamar `bindContext`.
 */
export function bindContext(partial: ExecutionContextExtras): void {
  const current = storage.getStore();
  if (!current) {
    return;
  }
  for (const [key, value] of Object.entries(partial)) {
    if (value !== undefined) {
      (current as unknown as Record<string, string>)[key] = value;
    }
  }
}

export function getContext(): ExecutionContext | undefined {
  return storage.getStore();
}
