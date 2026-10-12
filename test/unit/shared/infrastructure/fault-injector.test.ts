import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FaultPoint, NoopFaultInjector } from "../../../../src/shared/application/fault-injector.port";
import {
  EnvFaultInjector,
  createFaultInjector,
  parseFaultSpec,
} from "../../../../src/shared/infrastructure/fault-injection/env-fault-injector";

describe("parseFaultSpec", () => {
  it("parses a point and an action", () => {
    expect(parseFaultSpec("after_commit_before_ack=crash")).toEqual({
      point: FaultPoint.AfterCommitBeforeAck,
      action: "crash",
    });
  });

  it.each(["", "after_commit_before_ack", "nowhere=crash", "after_commit_before_ack=explode", "a=b=c"])(
    "rejects '%s'",
    (value) => {
      expect(() => parseFaultSpec(value)).toThrow("Invalid FAULT_INJECTION");
    },
  );
});

describe("createFaultInjector", () => {
  it("is a no-op unless NODE_ENV is test", () => {
    const injector = createFaultInjector({
      NODE_ENV: "production",
      FAULT_INJECTION: "after_commit_before_ack=crash",
    });
    expect(injector).toBeInstanceOf(NoopFaultInjector);
  });

  it("is a no-op without FAULT_INJECTION", () => {
    expect(createFaultInjector({ NODE_ENV: "test" })).toBeInstanceOf(NoopFaultInjector);
  });

  it("is active in test when configured", () => {
    const injector = createFaultInjector({
      NODE_ENV: "test",
      FAULT_INJECTION: "after_ledger_before_commit=crash",
    });
    expect(injector).toBeInstanceOf(EnvFaultInjector);
  });

  it("requires a marker file for crash_once", () => {
    expect(() =>
      createFaultInjector({ NODE_ENV: "test", FAULT_INJECTION: "after_ledger_before_commit=crash_once" }),
    ).toThrow("FAULT_INJECTION_MARKER");
  });
});

describe("EnvFaultInjector", () => {
  it("kills only at the configured point, every time for 'crash'", () => {
    let kills = 0;
    const injector = new EnvFaultInjector(
      { point: FaultPoint.AfterCommitBeforeAck, action: "crash" },
      { kill: () => (kills += 1) },
    );
    injector.reach(FaultPoint.AfterPublishBeforeCommit);
    expect(kills).toBe(0);
    injector.reach(FaultPoint.AfterCommitBeforeAck);
    injector.reach(FaultPoint.AfterCommitBeforeAck);
    expect(kills).toBe(2);
  });

  it("kills once across processes sharing the marker for 'crash_once'", () => {
    const dir = mkdtempSync(join(tmpdir(), "fault-"));
    try {
      let kills = 0;
      const spec = { point: FaultPoint.AfterPublishBeforeCommit, action: "crash_once" as const };
      const options = { kill: () => (kills += 1), markerPath: join(dir, "marker") };
      const first = new EnvFaultInjector(spec, options);
      const restarted = new EnvFaultInjector(spec, options);

      first.reach(FaultPoint.AfterPublishBeforeCommit);
      restarted.reach(FaultPoint.AfterPublishBeforeCommit);
      first.reach(FaultPoint.AfterPublishBeforeCommit);

      expect(kills).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
