import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createTestDatabase, type TestDatabaseContext } from "../../support/database";

describe("Database Migrations Reversibility (up -> down -> up)", () => {
  let db: TestDatabaseContext;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db.teardown();
  });

  it("should cleanly reverse all migrations with down and reapply with up", async () => {
    const migrator = db.orm.getMigrator();

    // Reverte todas as 3 migrations (3 para 2, 2 para 1, 1 para 0)
    await migrator.down();
    await migrator.down();
    await migrator.down();

    const tablesAfterDown = await db.orm.em.execute(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_type = 'BASE TABLE'
         AND table_name <> 'mikro_orm_migrations'`,
    );

    // Não deve sobrar nenhuma tabela de negócio no schema público
    expect(tablesAfterDown).toEqual([]);

    // Re-aplica todas as migrations
    await migrator.up();

    const tablesAfterUp = await db.orm.em.execute(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_type = 'BASE TABLE'
         AND table_name <> 'mikro_orm_migrations'
       ORDER BY table_name`,
    );

    const tableNames = tablesAfterUp.map((r: any) => r.table_name);
    expect(tableNames).toContain("wallets");
    expect(tableNames).toContain("wager_transactions");
    expect(tableNames).toContain("wallet_ledger_entries");
    expect(tableNames).toContain("inbox_messages");
    expect(tableNames).toContain("outbox_messages");
  });
});
