import { describe, expect, it } from "bun:test";
import { SystemClock } from "../../../src/shared/infrastructure/clock/system-clock";
import { UuidV7IdGenerator } from "../../../src/shared/infrastructure/id/uuid-v7-id-generator";

describe("Shared Application Ports and Implementations", () => {
  describe("SystemClock", () => {
    it("should return current Date", () => {
      const clock = new SystemClock();
      const before = Date.now();
      const now = clock.now();
      const after = Date.now();

      expect(now).toBeInstanceOf(Date);
      expect(now.getTime()).toBeGreaterThanOrEqual(before);
      expect(now.getTime()).toBeLessThanOrEqual(after);
    });
  });

  describe("UuidV7IdGenerator", () => {
    it("should generate valid UUID v7 format with version 7 bit", () => {
      const generator = new UuidV7IdGenerator();
      const id1 = generator.generate();
      const id2 = generator.generate();

      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      expect(id1).toMatch(uuidRegex);
      expect(id2).toMatch(uuidRegex);
      expect(id1).not.toBe(id2);
    });

    it("should generate monotonic/chronologically ordered IDs", async () => {
      const generator = new UuidV7IdGenerator();
      const first = generator.generate();
      // Delay de 2ms para garantir avanço de milissegundo no timestamp de cabeçalho
      await new Promise((resolve) => setTimeout(resolve, 2));
      const second = generator.generate();

      expect(first < second).toBe(true);
    });
  });
});

