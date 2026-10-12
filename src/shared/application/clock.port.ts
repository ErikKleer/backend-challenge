export interface Clock {
  /**
   * Retorna a data e hora atual do sistema.
   */
  now(): Date;
}

export const CLOCK_TOKEN = Symbol("Clock");
