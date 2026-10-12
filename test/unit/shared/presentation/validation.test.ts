import { describe, it, expect } from "bun:test";
import { z } from "zod";
import { Money } from "../../../../src/shared/domain/money";
import { MoneyPropsSchema } from "../../../../src/shared/presentation/money-props.schema";
import { RequestValidationError } from "../../../../src/shared/presentation/request-validation.error";
import { ZodValidationPipe } from "../../../../src/shared/presentation/zod-validation.pipe";

describe("MoneyPropsSchema", () => {
  it("converts the contract shape into Money", () => {
    const result = MoneyPropsSchema.parse({ amount: "1000.00", currency: "BRL" });

    expect(result).toBeInstanceOf(Money);
    expect(result.amount).toBe("1000.00");
    expect(result.currency).toBe("BRL");
  });

  it("accepts zero", () => {
    expect(MoneyPropsSchema.parse({ amount: "0.00", currency: "BRL" }).isZero()).toBe(true);
  });

  const invalidAmounts: unknown[] = ["-1.00", "10", "10.5", "10.505", "1e3", "NaN", "", " 10.00", "01.00", 10, 10.5, null];
  for (const amount of invalidAmounts) {
    it(`rejects amount ${JSON.stringify(amount)}`, () => {
      const result = MoneyPropsSchema.safeParse({ amount, currency: "BRL" });
      expect(result.success).toBe(false);
    });
  }

  for (const currency of ["brl", "BR", "BRLL", "", 986, undefined]) {
    it(`rejects currency ${JSON.stringify(currency)}`, () => {
      expect(MoneyPropsSchema.safeParse({ amount: "1.00", currency }).success).toBe(false);
    });
  }

  it("rejects non-object values", () => {
    for (const value of [undefined, null, "10.00", 10, []]) {
      expect(MoneyPropsSchema.safeParse(value).success).toBe(false);
    }
  });

  it("explains the format violation with the domain message", () => {
    const result = MoneyPropsSchema.safeParse({ amount: "10.5", currency: "BRL" });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("exactly 2 decimal places");
    }
  });
});

describe("ZodValidationPipe", () => {
  const pipe = new ZodValidationPipe(
    z.object({ name: z.string().min(1), balance: MoneyPropsSchema }),
  );

  it("returns the schema output", () => {
    const value = pipe.transform({ name: "a", balance: { amount: "5.00", currency: "BRL" } });

    expect(value.balance).toBeInstanceOf(Money);
  });

  it("throws RequestValidationError with one issue per field and its path", () => {
    try {
      pipe.transform({ name: "", balance: { amount: "5", currency: "BRL" } });
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(RequestValidationError);
      const paths = (error as RequestValidationError).issues.map((issue) => issue.path).sort();
      expect(paths).toEqual(["balance", "name"]);
    }
  });

  it("rejects an absent body", () => {
    expect(() => pipe.transform(undefined)).toThrow(RequestValidationError);
  });
});
