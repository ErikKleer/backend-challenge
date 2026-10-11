import { MikroORM } from "@mikro-orm/core";
import config from "../mikro-orm.config";

async function main() {
  const action = process.argv[2] || "up";
  const orm = await MikroORM.init(config);
  const migrator = orm.getMigrator();

  if (action === "up") {
    await migrator.up();
  } else if (action === "down") {
    await migrator.down();
  }

  await orm.close(true);
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
