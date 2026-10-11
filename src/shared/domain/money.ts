import Decimal from "decimal.js";
import { CurrencyMismatchError, InvalidMoneyError } from "./domain.error";

/**
 * Instância isolada do Decimal para evitar qualquer efeito colateral global.
 * Configurada com precisão alta e sem arredondamentos implícitos.
 */
const SafeDecimal = Decimal.clone({
  precision: 28,
  rounding: Decimal.ROUND_DOWN,
  toExpNeg: -30,
  toExpPos: 30,
});

export interface MoneyProps {
  amount: string;
  currency: string;
}

// Regex estrita para amount interno:
// - Sinal negativo opcional (-?)
// - Inteiro: 0 ou [1-9]\d* (até 17 dígitos)
// - Exatamente duas casas decimais (\.\d{2})
// - Espaços, zeros à esquerda (ex: 01.00), notação científica e outros formatos são proibidos.
const MONEY_PATTERN = /^-?(0|[1-9]\d{0,16})\.\d{2}$/;

// Regex estrita para amount vindo de contrato externo (HTTP/SQS): estritamente não-negativo.
const CONTRACT_MONEY_PATTERN = /^(0|[1-9]\d{0,16})\.\d{2}$/;

// Código ISO-4217 de 3 letras maiúsculas.
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Value Object imutável que representa dinheiro com escala fixa de 2 casas decimais.
 */
export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  /**
   * Constrói uma instância de Money a partir de props internas.
   * Permite valores negativos (usados em diferenças/reconciliação e operações de negação).
   * Rejeita -0.00, valores malformados ou escala divergente de 2 casas decimais.
   */
  public static from(props: MoneyProps): Money {
    if (!props || typeof props.amount !== "string" || typeof props.currency !== "string") {
      throw new InvalidMoneyError("Amount and currency must be strings");
    }

    const { amount, currency } = props;

    if (!CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(`Invalid currency code: '${currency}'. Expected 3 uppercase letters.`);
    }

    if (!MONEY_PATTERN.test(amount)) {
      throw new InvalidMoneyError(
        `Invalid amount format: '${amount}'. Expected format '^-?(0|[1-9]\\d{0,16})\\.\\d{2}$'`,
      );
    }

    if (amount === "-0.00") {
      throw new InvalidMoneyError("Invalid amount format: '-0.00' is not permitted");
    }

    const decimalValue = new SafeDecimal(amount);
    if (!decimalValue.isFinite()) {
      throw new InvalidMoneyError(`Amount is not finite: '${amount}'`);
    }

    return new Money(decimalValue, currency);
  }

  /**
   * Constrói uma instância de Money a partir de contratos externos (HTTP / SQS).
   * Rejeita estritamente valores negativos.
   */
  public static fromContract(props: MoneyProps): Money {
    if (!props || typeof props.amount !== "string" || typeof props.currency !== "string") {
      throw new InvalidMoneyError("Amount and currency must be strings");
    }

    const { amount, currency } = props;

    if (!CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(`Invalid currency code: '${currency}'. Expected 3 uppercase letters.`);
    }

    if (!CONTRACT_MONEY_PATTERN.test(amount)) {
      throw new InvalidMoneyError(
        `Invalid contract amount format: '${amount}'. Must be non-negative with exactly 2 decimal places.`,
      );
    }

    const decimalValue = new SafeDecimal(amount);
    if (!decimalValue.isFinite()) {
      throw new InvalidMoneyError(`Amount is not finite: '${amount}'`);
    }

    return new Money(decimalValue, currency);
  }

  /**
   * Cria uma instância de valor zero na moeda informada.
   */
  public static zero(currency: string): Money {
    return Money.from({ amount: "0.00", currency });
  }

  // ---- Operações aritméticas

  /**
   * Soma dois valores monetários da mesma moeda.
   */
  public add(other: Money): Money {
    this.assertSameCurrency(other);
    const result = this.value.plus(other.value);
    return new Money(result, this.currency);
  }

  /**
   * Subtrai outro valor monetário da mesma moeda.
   */
  public subtract(other: Money): Money {
    this.assertSameCurrency(other);
    const result = this.value.minus(other.value);
    return new Money(result, this.currency);
  }

  /**
   * Inverte o sinal do valor monetário.
   */
  public negate(): Money {
    if (this.value.isZero()) {
      return this;
    }
    const result = this.value.negated();
    return new Money(result, this.currency);
  }

  // ---- Predicados e comparações

  public isZero(): boolean {
    return this.value.isZero();
  }

  public isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  public isNegative(): boolean {
    return this.value.lessThan(0);
  }

  public isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  public equals(other: Money): boolean {
    if (this.currency !== other.currency) {
      return false;
    }
    return this.value.equals(other.value);
  }

  // ---- Serialização e representação
  public get amount(): string {
    return this.value.toFixed(2);
  }


  public toJSON(): MoneyProps {
    return {
      amount: this.value.toFixed(2),
      currency: this.currency,
    };
  }

  public toString(): string {
    return `${this.value.toFixed(2)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
