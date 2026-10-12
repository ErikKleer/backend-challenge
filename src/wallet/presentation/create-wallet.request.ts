import { z } from "zod";
import { MoneyPropsSchema } from "../../shared/presentation/money-props.schema";

export const CreateWalletBodySchema = z.object(
  {
    playerId: z
      .string({
        required_error: "playerId is required",
        invalid_type_error: "playerId must be a string",
      })
      .min(1, "playerId must not be empty")
      .max(128, "playerId must have at most 128 characters"),
    initialBalance: MoneyPropsSchema,
  },
  {
    required_error: "Request body is required",
    invalid_type_error: "Request body must be a JSON object",
  },
);

export type CreateWalletBody = z.output<typeof CreateWalletBodySchema>;
