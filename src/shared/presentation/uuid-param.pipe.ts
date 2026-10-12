import type { PipeTransform } from "@nestjs/common";
import { RequestValidationError } from "./request-validation.error";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Rejeita com 400 um parâmetro de rota que não seja UUID. Sem isso o PostgreSQL
 * responderia `invalid input syntax for type uuid` e o cliente veria um 500.
 */
export class UuidParamPipe implements PipeTransform<unknown, string> {
  constructor(private readonly name: string) {}

  public transform(value: unknown): string {
    if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
      throw new RequestValidationError(`${this.name} must be a UUID`, [
        { path: this.name, message: "must be a valid UUID" },
      ]);
    }
    return value.toLowerCase();
  }
}
