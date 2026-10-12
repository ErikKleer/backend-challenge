import { MikroORM } from "@mikro-orm/postgresql";
import { Migrator } from "@mikro-orm/migrations";
import { randomBytes } from "node:crypto";
import config from "../../mikro-orm.config";

export interface TestDatabaseContext {
  url: string;
  dbName: string;
  orm: MikroORM;
  teardown: () => Promise<void>;
}

/**
 * Cria um banco de dados novo e isolado por suíte (wagering_test_<aleatorio>),
 * conecta no banco administrativo PostgreSQL, executa as migrations
 * e devolve a conexão ORM e a rotina de teardown que derruba o banco criado.
 *
 * Motivo do isolamento por banco:
 * Triggers de proteção e regras estruturais append-only (como o bloqueio de TRUNCATE
 * e DELETE no ledger de auditoria) impedem limpeza e truncamento tradicionais entre
 * testes. O isolamento confiável vem de um banco exclusivo por suíte e IDs únicos por teste.
 */
export async function createTestDatabase(): Promise<TestDatabaseContext> {
  const adminUrl =
    process.env.TEST_ADMIN_DATABASE_URL ||
    process.env.DATABASE_URL ||
    "postgresql://postgres:postgres@localhost:5432/wagering_db";

  const adminOrm = await MikroORM.init({
    ...config,
    clientUrl: adminUrl,
    dbName: "wagering_db",
  });

  const suffix = randomBytes(6).toString("hex");
  const dbName = `wagering_test_${suffix}`;

  await adminOrm.em.execute(`CREATE DATABASE "${dbName}"`);
  await adminOrm.close(true);

  const parsedUrl = new URL(adminUrl);
  parsedUrl.pathname = `/${dbName}`;
  const testDbUrl = parsedUrl.toString();

  const testOrm = await MikroORM.init({
    ...config,
    clientUrl: testDbUrl,
    dbName,
    extensions: [Migrator],
    migrations: {
      path: "migrations",
      glob: "!(*.d).{ts,js}",
    },
  });

  const migrator = testOrm.getMigrator();
  await migrator.up();

  return {
    url: testDbUrl,
    dbName,
    orm: testOrm,
    teardown: async () => {
      await testOrm.close(true);
      const cleanupAdminOrm = await MikroORM.init({
        ...config,
        clientUrl: adminUrl,
        dbName: "wagering_db",
      });
      await cleanupAdminOrm.em.execute(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await cleanupAdminOrm.close(true);
    },
  };
}
