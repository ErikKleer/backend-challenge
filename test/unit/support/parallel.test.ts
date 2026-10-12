import { describe, expect, it } from "bun:test";
import { runInParallel, waitFor } from "../../support/parallel";

describe("runInParallel", () => {
  it("holds every task at the gate until all have arrived", async () => {
    const started: number[] = [];
    let startedBeforeGateOpened = 0;

    const results = await runInParallel(20, async (index) => {
      started.push(index);
      // Se o portão não segurasse, as primeiras tarefas já teriam terminado aqui.
      startedBeforeGateOpened = Math.max(startedBeforeGateOpened, started.length);
      await Promise.resolve();
      return index * 2;
    });

    expect(results).toEqual(Array.from({ length: 20 }, (_unused, i) => i * 2));
    expect(started).toHaveLength(20);
    expect(startedBeforeGateOpened).toBe(20);
  });

  it("propagates the first failure", async () => {
    await expect(
      runInParallel(3, async (index) => {
        if (index === 1) {
          throw new Error("boom");
        }
        return index;
      }),
    ).rejects.toThrow("boom");
  });
});

describe("waitFor", () => {
  it("returns as soon as the condition holds", async () => {
    let calls = 0;

    await waitFor(() => (calls += 1) >= 3, { intervalMs: 1 });

    expect(calls).toBe(3);
  });

  it("supports async conditions", async () => {
    let ready = false;
    setTimeout(() => {
      ready = true;
    }, 5);

    await waitFor(async () => ready, { intervalMs: 1 });

    expect(ready).toBe(true);
  });

  it("fails with a clear message on timeout", async () => {
    await expect(
      waitFor(() => false, { timeoutMs: 30, intervalMs: 5, description: "the impossible" }),
    ).rejects.toThrow("Timed out after 30ms waiting for the impossible");
  });
});
