import { describe, it, expect } from "bun:test";
import { Reflector } from "@nestjs/core";
import { AuthGuard } from "../../../src/auth/auth.guard";
import { NoopProviderIdentity } from "../../../src/auth/noop-provider-identity";
import { Public } from "../../../src/auth/public.decorator";

class ProtectedController {
  public handler(): void {}

  @Public()
  public open(): void {}
}

@Public()
class OpenController {
  public handler(): void {}
}

function contextFor(cls: new () => object, method: string) {
  const handler = (cls.prototype as Record<string, () => void>)[method];
  return {
    getHandler: () => handler,
    getClass: () => cls,
  } as never;
}

describe("AuthGuard (no-op)", () => {
  const guard = new AuthGuard(new Reflector());

  it("allows requests to regular routes", () => {
    expect(guard.canActivate(contextFor(ProtectedController, "handler"))).toBe(true);
  });

  it("allows requests to routes marked @Public()", () => {
    expect(guard.canActivate(contextFor(ProtectedController, "open"))).toBe(true);
    expect(guard.canActivate(contextFor(OpenController, "handler"))).toBe(true);
  });
});

describe("NoopProviderIdentity", () => {
  it("resolves no identity for any request", async () => {
    expect(await new NoopProviderIdentity().resolve({ headers: {} })).toBeUndefined();
  });
});
