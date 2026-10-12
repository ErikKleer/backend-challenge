import { z } from "zod";
import { DomainError } from "../domain/domain.error";
import { Money } from "../domain/money";

/**
 * Shape de dinheiro nas bordas (`{ amount: "10.00", currency: "BRL" }`). A regra de
 * formato (string com exatamente 2 casas, não negativa, moeda ISO) é do domínio:
 * o schema só garante os tipos e delega a `Money.fromContract`, repassando a mensagem
 * do domínio. Entrega `Money`, nunca `number`.
 */
export const MoneyPropsSchema = z
  .object(
    {
      amount: z.string({
        required_error: "amount is required",
        invalid_type_error: 'amount must be a string such as "10.00"',
      }),
      currency: z.string({
        required_error: "currency is required",
        invalid_type_error: 'currency must be a string such as "BRL"',
      }),
    },
    {
      required_error: "Money is required",
      invalid_type_error: "Money must be an object with amount and currency",
    },
  )
  .transform((props, ctx): Money => {
    try {
      return Money.fromContract(props);
    } catch (error) {
      if (error instanceof DomainError) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: error.message });
        return z.NEVER;
      }
      throw error;
    }
  });
