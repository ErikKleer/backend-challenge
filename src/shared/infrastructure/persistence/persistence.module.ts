import { type DynamicModule, Module } from "@nestjs/common";
import { EntityManager as CoreEntityManager } from "@mikro-orm/core";
import { EntityManager } from "@mikro-orm/postgresql";
import { CLOCK_TOKEN } from "../../application/clock.port";
import { SystemClock } from "../clock/system-clock";
import { ID_GENERATOR_TOKEN } from "../../application/id-generator.port";
import { UuidV7IdGenerator } from "../id/uuid-v7-id-generator";
import { UNIT_OF_WORK_TOKEN } from "../../application/unit-of-work.port";
import { MikroOrmUnitOfWork } from "./mikro-orm-unit-of-work";
import { WALLET_REPOSITORY_TOKEN } from "../../../wallet/application/wallet.repository.port";
import { MikroOrmWalletRepository } from "../../../wallet/infrastructure/persistence/wallet.repository";
import { LEDGER_REPOSITORY_TOKEN } from "../../../wallet/application/ledger.repository.port";
import { MikroOrmLedgerRepository } from "../../../wallet/infrastructure/persistence/ledger.repository";
import { RECONCILIATION_REPOSITORY_TOKEN } from "../../../wallet/application/reconciliation.repository.port";
import { MikroOrmReconciliationRepository } from "../../../wallet/infrastructure/persistence/reconciliation.repository";
import { WAGER_TRANSACTION_REPOSITORY_TOKEN } from "../../../wagering/application/wager-transaction.repository.port";
import { MikroOrmWagerTransactionRepository } from "../../../wagering/infrastructure/persistence/wager-transaction.repository";
import { OUTBOX_REPOSITORY_TOKEN } from "../../../messaging/application/outbox.repository.port";
import { MikroOrmOutboxRepository } from "../../../messaging/infrastructure/persistence/outbox.repository";
import { INBOX_REPOSITORY_TOKEN } from "../../../messaging/application/inbox.repository.port";
import { POSTGRES_READINESS_CHECK_TOKEN } from "../../application/readiness-check.port";
import { PostgresReadinessCheck } from "./postgres-readiness-check";
import { MikroOrmInboxRepository } from "../../../messaging/infrastructure/persistence/inbox.repository";

@Module({})
export class PersistenceModule {
  public static forRoot(customEntityManager?: EntityManager): DynamicModule {
    const emProvider = customEntityManager
      ? {
          provide: EntityManager,
          useValue: customEntityManager,
        }
      : {
          // O MikroOrmModule registra o EntityManager do pacote core; o do driver
          // (SqlEntityManager) não é resolvido de forma confiável sob Bun.
          provide: EntityManager,
          useFactory: (em: CoreEntityManager) => em as EntityManager,
          inject: [CoreEntityManager],
        };

    const providers = [
      emProvider,
      {
        provide: CLOCK_TOKEN,
        useClass: SystemClock,
      },
      {
        provide: ID_GENERATOR_TOKEN,
        useClass: UuidV7IdGenerator,
      },
      {
        provide: UNIT_OF_WORK_TOKEN,
        useFactory: (em: EntityManager) => {
          const timeoutMs = Number(process.env.DB_LOCK_TIMEOUT_MS) || 2000;
          return new MikroOrmUnitOfWork(em, timeoutMs);
        },
        inject: [EntityManager],
      },
      {
        provide: WALLET_REPOSITORY_TOKEN,
        useFactory: (em: EntityManager) => {
          const timeoutMs = Number(process.env.DB_LOCK_TIMEOUT_MS) || 2000;
          return new MikroOrmWalletRepository(em, timeoutMs);
        },
        inject: [EntityManager],
      },
      {
        provide: LEDGER_REPOSITORY_TOKEN,
        useFactory: (em: EntityManager) => {
          return new MikroOrmLedgerRepository(em);
        },
        inject: [EntityManager],
      },
      {
        provide: RECONCILIATION_REPOSITORY_TOKEN,
        useFactory: (em: EntityManager) => new MikroOrmReconciliationRepository(em),
        inject: [EntityManager],
      },
      {
        provide: WAGER_TRANSACTION_REPOSITORY_TOKEN,
        useFactory: (em: EntityManager) => {
          return new MikroOrmWagerTransactionRepository(em);
        },
        inject: [EntityManager],
      },
      {
        provide: OUTBOX_REPOSITORY_TOKEN,
        useFactory: () => new MikroOrmOutboxRepository(),
      },
      {
        provide: INBOX_REPOSITORY_TOKEN,
        useFactory: () => new MikroOrmInboxRepository(),
      },
      {
        provide: POSTGRES_READINESS_CHECK_TOKEN,
        useFactory: (em: EntityManager) => new PostgresReadinessCheck(em),
        inject: [EntityManager],
      },
    ];

    return {
      module: PersistenceModule,
      global: true,
      providers,
      exports: [
        CLOCK_TOKEN,
        ID_GENERATOR_TOKEN,
        UNIT_OF_WORK_TOKEN,
        WALLET_REPOSITORY_TOKEN,
        LEDGER_REPOSITORY_TOKEN,
        RECONCILIATION_REPOSITORY_TOKEN,
        WAGER_TRANSACTION_REPOSITORY_TOKEN,
        OUTBOX_REPOSITORY_TOKEN,
        INBOX_REPOSITORY_TOKEN,
        POSTGRES_READINESS_CHECK_TOKEN,
      ],
    };
  }
}

