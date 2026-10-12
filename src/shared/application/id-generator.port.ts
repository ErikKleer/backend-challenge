export interface IdGenerator {
  /**
   * Gera um identificador único no formato UUID v7 ordenável no tempo.
   */
  generate(): string;
}

export const ID_GENERATOR_TOKEN = Symbol("IdGenerator");
