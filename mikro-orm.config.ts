import { defineConfig } from "@mikro-orm/postgresql";
import { Migrator } from "@mikro-orm/migrations";

export default defineConfig({
  dbName: process.env.DB_NAME || "wagering_db",
  clientUrl: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/wagering_db",
  entities: [],
  // Cada requisição em andamento segura uma conexão durante toda a transação; o teto
  // do pool é, portanto, o teto de transações financeiras simultâneas por instância.
  pool: { min: 2, max: Number(process.env.DB_POOL_MAX) || 10 },
  discovery: {
    warnWhenNoEntities: false,
  },
  extensions: [Migrator],
  migrations: {
    path: "migrations",
    glob: "!(*.d).{ts,js}",
  },
});

