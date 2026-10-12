import { describe, it, expect } from "bun:test";
import {
  bindContext,
  getContext,
  runWithContext,
} from "../../../../src/shared/infrastructure/observability/execution-context";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("execution context", () => {
  it("has no context outside runWithContext", () => {
    expect(getContext()).toBeUndefined();
    bindContext({ walletId: "w-1" });
    expect(getContext()).toBeUndefined();
  });

  it("propagates across await, Promise.all and setTimeout", async () => {
    await runWithContext({ correlationId: "c-1" }, async () => {
      await delay(1);
      expect(getContext()?.correlationId).toBe("c-1");

      const results = await Promise.all([
        (async () => {
          await delay(2);
          return getContext()?.correlationId;
        })(),
        Promise.resolve().then(() => getContext()?.correlationId),
      ]);
      expect(results).toEqual(["c-1", "c-1"]);

      const fromTimer = await new Promise<string | undefined>((resolve) => {
        setTimeout(() => resolve(getContext()?.correlationId), 1);
      });
      expect(fromTimer).toBe("c-1");
    });
  });

  it("bindContext enriches the current context and ignores undefined", async () => {
    await runWithContext({ correlationId: "c-1" }, async () => {
      bindContext({ walletId: "w-1", providerId: "p-1" });
      await delay(1);
      bindContext({ walletId: undefined, transactionId: "t-1" });
      expect(getContext()).toEqual({
        correlationId: "c-1",
        walletId: "w-1",
        providerId: "p-1",
        transactionId: "t-1",
      });
    });
  });

  it("does not mutate the object passed by the caller", () => {
    const initial = { correlationId: "c-1" };
    runWithContext(initial, () => bindContext({ walletId: "w-1" }));
    expect(initial).toEqual({ correlationId: "c-1" });
  });

  it("keeps concurrent contexts isolated", async () => {
    const seen = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        runWithContext({ correlationId: `c-${i}` }, async () => {
          bindContext({ walletId: `w-${i}` });
          await delay((i * 7) % 5);
          await Promise.resolve();
          return getContext();
        }),
      ),
    );

    seen.forEach((ctx, i) => {
      expect(ctx).toEqual({ correlationId: `c-${i}`, walletId: `w-${i}` });
    });
  });

  it("restores the outer context after a nested run", async () => {
    await runWithContext({ correlationId: "outer" }, async () => {
      await runWithContext({ correlationId: "inner" }, async () => {
        await delay(1);
        expect(getContext()?.correlationId).toBe("inner");
      });
      expect(getContext()?.correlationId).toBe("outer");
    });
  });
});
