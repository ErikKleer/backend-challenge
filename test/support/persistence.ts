import { NestFactory } from "@nestjs/core";
import { type INestApplicationContext } from "@nestjs/common";
import { PersistenceModule } from "../../src/shared/infrastructure/persistence/persistence.module";
import { CLOCK_TOKEN, type Clock } from "../../src/shared/application/clock.port";
import { ID_GENERATOR_TOKEN, type IdGenerator } from "../../src/shared/application/id-generator.port";
import { UNIT_OF_WORK_TOKEN, type UnitOfWork } from "../../src/shared/application/unit-of-work.port";
import { WALLET_REPOSITORY_TOKEN, type WalletRepository } from "../../src/wallet/application/wallet.repository.port";
import { LEDGER_REPOSITORY_TOKEN, type LedgerRepository } from "../../src/wallet/application/ledger.repository.port";
import { WAGER_TRANSACTION_REPOSITORY_TOKEN, type WagerTransactionRepository } from "../../src/wagering/application/wager-transaction.repository.port";
import type { TestDatabaseContext } from "./database";

export interface PersistenceTestContext {
  app: INestApplicationContext;
  clock: Clock;
  idGenerator: IdGenerator;
  unitOfWork: UnitOfWork;
  walletRepo: WalletRepository;
  ledgerRepo: LedgerRepository;
  transactionRepo: WagerTransactionRepository;
}

/**
 * Helper de teste reutilizável para configurar e obter instâncias injetadas
 * dos repositórios e UnitOfWork conectados a uma base isolada de teste.
 */
export async function createPersistenceTestContext(
  testDb: TestDatabaseContext,
): Promise<PersistenceTestContext> {
  const rootEm = testDb.orm.em;

  const app = await NestFactory.createApplicationContext(
    PersistenceModule.forRoot(rootEm),
    { logger: false },
  );

  return {
    app,
    clock: app.get<Clock>(CLOCK_TOKEN),
    idGenerator: app.get<IdGenerator>(ID_GENERATOR_TOKEN),
    unitOfWork: app.get<UnitOfWork>(UNIT_OF_WORK_TOKEN),
    walletRepo: app.get<WalletRepository>(WALLET_REPOSITORY_TOKEN),
    ledgerRepo: app.get<LedgerRepository>(LEDGER_REPOSITORY_TOKEN),
    transactionRepo: app.get<WagerTransactionRepository>(WAGER_TRANSACTION_REPOSITORY_TOKEN),
  };
}

