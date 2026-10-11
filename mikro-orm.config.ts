import { defineConfig } from "@mikro-orm/postgresql";
import { Migrator } from "@mikro-orm/migrations";

export default defineConfig({
  dbName: process.env.DB_NAME || "wagering_db",
  clientUrl: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/wagering_db",
  entities: [],
  extensions: [Migrator],
  migrations: {
    path: "migrations",
    glob: "!(*.d).{ts,js}",
  },
});
