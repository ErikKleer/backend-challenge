import { DomainError } from "../../domain/domain.error";
import {
  LockTimeoutError,
  PermanentInfrastructureError,
  TransientInfrastructureError,
  UniqueConstraintViolationError,
} from "./postgres-errors";

interface ErrorWithPotentialDbCodes {
  code?: string | number;
  errno?: string | number;
  routine?: string;
  constraint?: string;
  message?: string;
  parent?: {
    code?: string | number;
    constraint?: string;
    message?: string;
    routine?: string;
  };
  cause?: unknown;
}

/**
 * Classifica e normaliza erros emitidos pelo driver PostgreSQL / MikroORM.
 *
 * Mapeamentos:
 * - DomainError => propagado diretamente sem envelopamento
 * - 55P03 => LockTimeoutError (transient)
 * - 40P01 => TransientInfrastructureError (deadlock_detected)
 * - 40001 => TransientInfrastructureError (serialization_failure)
 * - 23505 => UniqueConstraintViolationError (unique_violation)
 * - Erros de rede/conexão (ECONNREFUSED, ETIMEDOUT, 08000, 08003, 08006, 57P01) => TransientInfrastructureError
 * - Demais erros não-banco => propagados intactos se não forem do driver
 * - Demais erros do banco => PermanentInfrastructureError
 */
export function classifyPostgreSqlError(error: unknown): Error {
  if (
    error instanceof DomainError ||
    error instanceof TransientInfrastructureError ||
    error instanceof PermanentInfrastructureError
  ) {
    return error;
  }

  const dbErr = error as ErrorWithPotentialDbCodes;
  const sqlState = String(dbErr?.code ?? dbErr?.parent?.code ?? "");
  const constraint = dbErr?.constraint ?? dbErr?.parent?.constraint;
  const rawMessage = dbErr?.message ?? String(error);

  // 55P03: lock_not_available (lock timeout atingido)
  if (sqlState === "55P03") {
    return new LockTimeoutError(
      `Database lock timeout occurred: ${rawMessage}`,
      error,
    );
  }

  // 40P01: deadlock_detected
  if (sqlState === "40P01") {
    return new TransientInfrastructureError(
      `Database deadlock detected: ${rawMessage}`,
      "DEADLOCK_DETECTED",
      error,
    );
  }

  // 40001: serialization_failure
  if (sqlState === "40001") {
    return new TransientInfrastructureError(
      `Database serialization failure: ${rawMessage}`,
      "SERIALIZATION_FAILURE",
      error,
    );
  }

  // 23505: unique_violation
  if (sqlState === "23505") {
    return new UniqueConstraintViolationError(
      `Database unique constraint violation: ${rawMessage}`,
      constraint,
      error,
    );
  }

  // Falhas de conexão / rede do PostgreSQL
  const connectionErrorCodes = [
    "ECONNREFUSED",
    "ETIMEDOUT",
    "ENOTFOUND",
    "ECONNRESET",
    "08000", // connection_exception
    "08003", // connection_does_not_exist
    "08006", // connection_failure
    "08001", // sqlclient_unable_to_establish_sqlconnection
    "08004", // sqlserver_rejected_establishment_of_sqlconnection
    "57P01", // admin_shutdown
    "57P02", // crash_shutdown
    "57P03", // cannot_connect_now
  ];

  const errno = String(dbErr?.errno ?? "");
  if (
    connectionErrorCodes.includes(sqlState) ||
    connectionErrorCodes.includes(errno) ||
    /connection terminated|connect ECONNREFUSED|connection timeout/i.test(rawMessage)
  ) {
    return new TransientInfrastructureError(
      `Database connection failure: ${rawMessage}`,
      "CONNECTION_FAILURE",
      error,
    );
  }

  // Se o erro tem código de SQLSTATE de 5 caracteres do PostgreSQL ou veio de driver de banco
  if (
    sqlState.length === 5 ||
    Boolean(dbErr?.routine) ||
    Boolean(dbErr?.parent) ||
    (error instanceof Error && error.constructor.name.includes("DriverException"))
  ) {
    return new PermanentInfrastructureError(
      `Database permanent error: ${rawMessage}`,
      "PERMANENT_DATABASE_ERROR",
      error,
    );
  }

  // Se for um erro regular de aplicação/negócio (ex: throw new Error("...")), propaga intacto
  if (error instanceof Error) {
    return error;
  }

  return new PermanentInfrastructureError(
    `Unknown permanent error: ${rawMessage}`,
    "PERMANENT_INFRASTRUCTURE_ERROR",
    error,
  );
}

