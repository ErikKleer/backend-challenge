import { describe, expect, it } from "bun:test";
import {
  classifyPostgreSqlError,
} from "../../../../src/shared/infrastructure/persistence/postgres-error-classifier";
import {
  LockTimeoutError,
  PermanentInfrastructureError,
  TransientInfrastructureError,
  UniqueConstraintViolationError,
} from "../../../../src/shared/infrastructure/persistence/postgres-errors";
import { InsufficientFundsError } from "../../../../src/shared/domain/domain.error";

describe("PostgreSQL Error Classification", () => {
  it("should classify 55P03 as LockTimeoutError", () => {
    const error = { code: "55P03", message: "canceling statement due to lock timeout" };
    const classified = classifyPostgreSqlError(error);

    expect(classified).toBeInstanceOf(LockTimeoutError);
    expect(classified).toBeInstanceOf(TransientInfrastructureError);
    expect((classified as LockTimeoutError).code).toBe("LOCK_TIMEOUT");
  });

  it("should classify 40P01 as TransientInfrastructureError (deadlock)", () => {
    const error = { code: "40P01", message: "deadlock detected" };
    const classified = classifyPostgreSqlError(error);

    expect(classified).toBeInstanceOf(TransientInfrastructureError);
    expect((classified as TransientInfrastructureError).code).toBe("DEADLOCK_DETECTED");
  });

  it("should classify 40001 as TransientInfrastructureError (serialization failure)", () => {
    const error = { code: "40001", message: "could not serialize access due to concurrent update" };
    const classified = classifyPostgreSqlError(error);

    expect(classified).toBeInstanceOf(TransientInfrastructureError);
    expect((classified as TransientInfrastructureError).code).toBe("SERIALIZATION_FAILURE");
  });

  it("should classify 23505 as UniqueConstraintViolationError with constraint name", () => {
    const error = {
      code: "23505",
      constraint: "uq_wager_transactions_idempotency_key",
      message: "duplicate key value violates unique constraint",
    };
    const classified = classifyPostgreSqlError(error);

    expect(classified).toBeInstanceOf(UniqueConstraintViolationError);
    expect(classified).toBeInstanceOf(PermanentInfrastructureError);
    expect((classified as UniqueConstraintViolationError).constraint).toBe(
      "uq_wager_transactions_idempotency_key",
    );
  });

  it("should classify connection refused / network errors as TransientInfrastructureError", () => {
    const networkErr1 = { code: "ECONNREFUSED", message: "connect ECONNREFUSED 127.0.0.1:5432" };
    const classified1 = classifyPostgreSqlError(networkErr1);
    expect(classified1).toBeInstanceOf(TransientInfrastructureError);
    expect((classified1 as TransientInfrastructureError).code).toBe("CONNECTION_FAILURE");

    const networkErr2 = { code: "08006", message: "connection failure" };
    const classified2 = classifyPostgreSqlError(networkErr2);
    expect(classified2).toBeInstanceOf(TransientInfrastructureError);

    const networkErr3 = { code: "57P01", message: "admin shutdown" };
    const classified3 = classifyPostgreSqlError(networkErr3);
    expect(classified3).toBeInstanceOf(TransientInfrastructureError);
  });

  it("should pass through DomainError without wrapping", () => {
    const domainErr = new InsufficientFundsError("Not enough balance");
    const classified = classifyPostgreSqlError(domainErr);

    expect(classified).toBe(domainErr);
    expect(classified).toBeInstanceOf(InsufficientFundsError);
  });

  it("should wrap unclassified PostgreSQL errors in PermanentInfrastructureError", () => {
    const dbErr = { code: "42P01", message: 'relation "wallets" does not exist' };
    const classified = classifyPostgreSqlError(dbErr);

    expect(classified).toBeInstanceOf(PermanentInfrastructureError);
    expect((classified as PermanentInfrastructureError).code).toBe("PERMANENT_DATABASE_ERROR");
  });
});

