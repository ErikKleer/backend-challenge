import { createBarrier } from "./barrier";

/**
 * Dispara `fn(0..n-1)` em paralelo real: todas as tarefas são criadas e ficam
 * paradas num portão até a última chegar, então começam juntas, sem `sleep`.
 * Devolve os resultados na ordem dos índices; a primeira falha rejeita a chamada
 * (um erro de lock inesperado deve quebrar o teste, não ser engolido).
 */
export async function runInParallel<T>(
  n: number,
  fn: (index: number) => Promise<T>,
): Promise<T[]> {
  const arrive = createBarrier(n);
  return Promise.all(
    Array.from({ length: n }, async (_unused, index) => {
      await arrive();
      return fn(index);
    }),
  );
}

export interface WaitForOptions {
  timeoutMs?: number;
  intervalMs?: number;
  /** Texto da falha em caso de timeout. */
  description?: string;
}

/**
 * Espera uma condição por polling até o timeout. Substitui `sleep` fixo: retorna
 * assim que a condição vale e falha com mensagem clara se ela nunca valer.
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  options: WaitForOptions = {},
): Promise<void> {
  const { timeoutMs = 10_000, intervalMs = 25, description = "condition" } = options;
  const deadline = Date.now() + timeoutMs;

  while (!(await condition())) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
}
