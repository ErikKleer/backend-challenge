import type { EntityManager } from "@mikro-orm/postgresql";
import type { ReadinessCheck } from "../../application/readiness-check.port";

/** `SELECT 1` pelo pool: prova que há conexão utilizável, não só que o servidor existe. */
export class PostgresReadinessCheck implements ReadinessCheck {
  public readonly name = "postgres";

  constructor(private readonly em: EntityManager) {}

  public async check(): Promise<void> {
    await this.em.getConnection().execute("select 1");
  }
}
