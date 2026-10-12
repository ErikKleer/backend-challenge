export interface UnitOfWork {
  /**
   * Executa uma função em um contexto transacional isolado (READ COMMITTED).
   * Se já houver uma transação em andamento no contexto assíncrono atual,
   * reaproveita a transação existente.
   */
  run<T>(fn: () => Promise<T>): Promise<T>;

  /**
   * Registra um callback para ser executado imediatamente após o commit com sucesso
   * da transação raiz do contexto atual.
   */
  afterCommit(fn: () => void | Promise<void>): void;
}

export const UNIT_OF_WORK_TOKEN = Symbol("UnitOfWork");
