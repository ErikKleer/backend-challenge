import { randomBytes } from "node:crypto";
import type { IdGenerator } from "../../application/id-generator.port";

export class UuidV7IdGenerator implements IdGenerator {
  public generate(): string {
    if (typeof Bun !== "undefined" && typeof Bun.randomUUIDv7 === "function") {
      return Bun.randomUUIDv7();
    }

    const bytes = randomBytes(16);
    const now = Date.now();
    bytes[0] = (now / 0x10000000000) & 0xff;
    bytes[1] = (now / 0x100000000) & 0xff;
    bytes[2] = (now / 0x1000000) & 0xff;
    bytes[3] = (now / 0x10000) & 0xff;
    bytes[4] = (now / 0x100) & 0xff;
    bytes[5] = now & 0xff;
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70; // version 7
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // variant RFC 4122

    return [
      bytes.subarray(0, 4).toString("hex"),
      bytes.subarray(4, 6).toString("hex"),
      bytes.subarray(6, 8).toString("hex"),
      bytes.subarray(8, 10).toString("hex"),
      bytes.subarray(10, 16).toString("hex"),
    ].join("-");
  }
}

