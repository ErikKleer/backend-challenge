import { describe, expect, it } from "bun:test";
import { CurrencyMismatchError, InvalidMoneyError } from "../../../../src/shared/domain/domain.error";
import { Money } from "../../../../src/shared/domain/money";

describe("Money Value Object", () => {
  describe("Creation with Money.from", () => {
    it("should create valid positive, zero and negative money", () => {
      const positive = Money.from({ amount: "25.00", currency: "BRL" });
      expect(positive.toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
      expect(positive.toString()).toBe("25.00 BRL");
      expect(positive.isPositive()).toBe(true);
      expect(positive.isZero()).toBe(false);
      expect(positive.isNegative()).toBe(false);

      const zero = Money.from({ amount: "0.00", currency: "BRL" });
      expect(zero.toJSON()).toEqual({ amount: "0.00", currency: "BRL" });
      expect(zero.isZero()).toBe(true);
      expect(zero.isPositive()).toBe(false);
      expect(zero.isNegative()).toBe(false);

      const negative = Money.from({ amount: "-10.50", currency: "BRL" });
      expect(negative.toJSON()).toEqual({ amount: "-10.50", currency: "BRL" });
      expect(negative.isNegative()).toBe(true);
      expect(negative.isPositive()).toBe(false);
      expect(negative.isZero()).toBe(false);
    });

    it("should accept maximum 17 integer digits with 2 decimal places", () => {
      const maxInt = "99999999999999999.99";
      const money = Money.from({ amount: maxInt, currency: "USD" });
      expect(money.toJSON().amount).toBe(maxInt);
    });

    it("should reject invalid amount formats", () => {
      const invalidAmounts = [
        "",
        " ",
        "25",
        "25.",
        "25.0",
        "25.000",
        "25.0000",
        "01.00",
        "-01.00",
        "-0.00",
        "+25.00",
        "25,00",
        "NaN",
        "Infinity",
        "1e2.00",
        "1e2",
        "abc",
        "100000000000000000.00",
      ];

      for (const amount of invalidAmounts) {
        expect(() => Money.from({ amount, currency: "BRL" })).toThrow(InvalidMoneyError);
      }
    });

    it("should reject non-string amount or currency", () => {
      // @ts-expect-error testing runtime validation
      expect(() => Money.from({ amount: 25.0, currency: "BRL" })).toThrow(InvalidMoneyError);
      // @ts-expect-error testing runtime validation
      expect(() => Money.from({ amount: "25.00", currency: 123 })).toThrow(InvalidMoneyError);
      // @ts-expect-error testing runtime validation
      expect(() => Money.from(null)).toThrow(InvalidMoneyError);
    });

    it("should reject invalid currency codes", () => {
      const invalidCurrencies = ["", "BR", "BRLX", "brl", "BR1", "B R"];
      for (const currency of invalidCurrencies) {
        expect(() => Money.from({ amount: "10.00", currency })).toThrow(InvalidMoneyError);
      }
    });
  });

  describe("Creation with Money.fromContract", () => {
    it("should create valid non-negative money and reject negative amounts", () => {
      const valid = Money.fromContract({ amount: "100.50", currency: "BRL" });
      expect(valid.toJSON()).toEqual({ amount: "100.50", currency: "BRL" });

      const zero = Money.fromContract({ amount: "0.00", currency: "BRL" });
      expect(zero.toJSON()).toEqual({ amount: "0.00", currency: "BRL" });

      expect(() => Money.fromContract({ amount: "-0.01", currency: "BRL" })).toThrow(InvalidMoneyError);
      expect(() => Money.fromContract({ amount: "-50.00", currency: "BRL" })).toThrow(InvalidMoneyError);
    });
  });

  describe("Arithmetic operations and immutability", () => {
    it("should calculate exact sums without floating point errors (0.10 + 0.20 = 0.30)", () => {
      const a = Money.from({ amount: "0.10", currency: "BRL" });
      const b = Money.from({ amount: "0.20", currency: "BRL" });
      const sum = a.add(b);

      expect(sum.toJSON().amount).toBe("0.30");
      expect(a.toJSON().amount).toBe("0.10");
      expect(b.toJSON().amount).toBe("0.20");
    });

    it("should subtract correctly", () => {
      const a = Money.from({ amount: "10.50", currency: "BRL" });
      const b = Money.from({ amount: "3.25", currency: "BRL" });
      const diff = a.subtract(b);
      expect(diff.toJSON().amount).toBe("7.25");
    });

    it("should negate correctly", () => {
      const positive = Money.from({ amount: "10.50", currency: "BRL" });
      const negated = positive.negate();
      expect(negated.toJSON().amount).toBe("-10.50");
      expect(negated.negate().toJSON().amount).toBe("10.50");

      const zero = Money.zero("BRL");
      expect(zero.negate().toJSON().amount).toBe("0.00");
    });

    it("should throw CurrencyMismatchError when operating across different currencies", () => {
      const brl = Money.from({ amount: "10.00", currency: "BRL" });
      const usd = Money.from({ amount: "10.00", currency: "USD" });

      expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
      expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
      expect(() => brl.isLessThan(usd)).toThrow(CurrencyMismatchError);
    });
  });

  describe("Comparisons and equality", () => {
    it("should correctly compare using isLessThan and equals", () => {
      const m1 = Money.from({ amount: "10.00", currency: "BRL" });
      const m2 = Money.from({ amount: "20.00", currency: "BRL" });
      const m3 = Money.from({ amount: "10.00", currency: "USD" });

      expect(m1.isLessThan(m2)).toBe(true);
      expect(m2.isLessThan(m1)).toBe(false);
      expect(m1.equals(m1)).toBe(true);
      expect(m1.equals(m2)).toBe(false);
      expect(m1.equals(m3)).toBe(false);
    });
  });
});
