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
 * - 55P03 => LockTimeoutError (transient)
 * - 40P01 => TransientInfrastructureError (deadlock_detected)
 * - 40001 => TransientInfrastructureError (serialization_failure)
 * - 23505 => UniqueConstraintViolationError (unique_violation)
 * - Erros de rede/conexão (ECONNREFUSED, ETIMEDOUT, 08000, 08003, 08006, 57P01) => TransientInfrastructureError
 * - Demais => PermanentInfrastructureError ou propaga a própria exceção se já classificada
 */
export function classifyPostgreSqlError(error: unknown): Error {
  if (
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

  // Outros erros de banco não classificados como transitórios
  return new PermanentInfrastructureError(
    `Database permanent error: ${rawMessage}`,
    "PERMANENT_DATABASE_ERROR",
    error,
  );
}
