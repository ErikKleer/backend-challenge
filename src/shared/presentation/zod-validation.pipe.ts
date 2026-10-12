import type { PipeTransform } from "@nestjs/common";
import type { ZodTypeAny, z } from "zod";
import {
  RequestValidationError,
  type ValidationIssue,
} from "./request-validation.error";

/**
 * Valida e converte a entrada com um schema zod. O valor devolvido é a **saída**
 * do schema (por exemplo, `Money` no lugar do shape string), e o schema decide o que
 * descartar de campos desconhecidos.
 */
export class ZodValidationPipe<S extends ZodTypeAny> implements PipeTransform<unknown, z.output<S>> {
  constructor(private readonly schema: S) {}

  public transform(value: unknown): z.output<S> {
    const result = this.schema.safeParse(value);
    if (result.success) {
      return result.data;
    }

    const issues: ValidationIssue[] = result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));
    throw new RequestValidationError("Request validation failed", issues);
  }
}
