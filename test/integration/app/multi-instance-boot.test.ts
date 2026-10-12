import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createTestDatabase, type TestDatabaseContext } from "../../support/database";
import { assertAllWalletsConsistent } from "../../support/invariants";
import { createPersistenceTestContext, type PersistenceTestContext } from "../../support/persistence";
import { type AppInstance, postWagerTransaction, startInstances, stopAll } from "../../support/process";
import { createTestQueues, type TestQueues } from "../../support/sqs";
import { WageringHarness } from "../../support/wagering";

describe("application instances as real processes", () => {
  let db: TestDatabaseContext;
  let ctx: PersistenceTestContext;
  let queues: TestQueues;
  let instances: AppInstance[] = [];

  beforeAll(async () => {
    db = await createTestDatabase();
    ctx = await createPersistenceTestContext(db);
    queues = await createTestQueues();
  });

  afterAll(async () => {
    await stopAll(instances);
    await queues.teardown();
    await ctx.app.close();
    await db.teardown();
  });

  it("boots independent processes on distinct ports against the same database", async () => {
    instances = await startInstances(3, { db, queues });

    expect(new Set(instances.map((instance) => instance.port)).size).toBe(3);
    for (const instance of instances) {
      expect(instance.alive).toBe(true);
      const live = await fetch(`${instance.baseUrl}/health/live`);
      expect(live.status).toBe(200);
    }
    // O log estruturado de cada processo é capturado
    expect(instances[0]!.logs().some((entry) => entry.msg === "application started")).toBe(true);
  });

  it("serves the same wallet from any instance and survives the death of one of them", async () => {
    const harness = new WageringHarness(ctx);
    const wallet = await harness.createWallet("100.00");
    const [first, second, third] = instances as [AppInstance, AppInstance, AppInstance];

    await first.kill("SIGKILL");
    expect(first.alive).toBe(false);

    const a = await postWagerTransaction(second.baseUrl, harness.command(wallet));
    const b = await postWagerTransaction(third.baseUrl, harness.command(wallet));
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(b.body.balance.amount).toBe("80.00");

    expect(await assertAllWalletsConsistent(db.orm.em)).toBeGreaterThanOrEqual(1);
  });
});
