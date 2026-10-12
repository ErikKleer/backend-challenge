import { AsyncLocalStorage } from "node:async_hooks";
import { type EntityManager, IsolationLevel } from "@mikro-orm/postgresql";
import type { UnitOfWork } from "../../application/unit-of-work.port";
import { classifyPostgreSqlError } from "./postgres-error-classifier";

interface TransactionalContext {
  em: EntityManager;
  afterCommitCallbacks: Array<() => void | Promise<void>>;
}

export class MikroOrmUnitOfWork implements UnitOfWork {
  private static readonly storage = new AsyncLocalStorage<TransactionalContext>();

  constructor(
    private readonly rootEm: EntityManager,
    private readonly defaultLockTimeoutMs: number = 2000,
  ) {}

  /**
   * Retorna o EntityManager associado à transação corrente no contexto assíncrono.
   * Lança erro explicativo caso seja invocado fora de um bloco UnitOfWork.run.
   */
  public static getCurrentEntityManager(): EntityManager {
    const context = MikroOrmUnitOfWork.storage.getStore();
    if (!context) {
      throw new Error(
        "No active transactional EntityManager in AsyncLocalStorage. Repositories must be invoked inside UnitOfWork.run().",
      );
    }
    return context.em;
  }

  /**
   * Executa a função fn dentro de uma transação PostgreSQL com nível de isolamento READ COMMITTED
   * e fork exclusivo de EntityManager.
   *
   * Se já existir uma transação ativa no contexto assíncrono atual, reutiliza o contexto.
   * Se for a transação raiz, após o commit bem-sucedido executa todos os callbacks de afterCommit.
   */
  public async run<T>(fn: () => Promise<T>): Promise<T> {
    const existingContext = MikroOrmUnitOfWork.storage.getStore();

    // Se já estivermos dentro de um UoW, reaproveitamos o EntityManager transacional existente
    if (existingContext) {
      return await fn();
    }

    const forkEm = this.rootEm.fork();
    const afterCommitCallbacks: Array<() => void | Promise<void>> = [];

    let result: T;
    try {
      result = await forkEm.transactional(
        async (txEm) => {
          // Configura o lock_timeout da transação para evitar esperas indefinidas em concorrência
          await txEm.execute(
            `SET LOCAL lock_timeout = '${this.defaultLockTimeoutMs}ms';`,
          );

          const context: TransactionalContext = {
            em: txEm as EntityManager,
            afterCommitCallbacks,
          };

          return await MikroOrmUnitOfWork.storage.run(context, async () => {
            return await fn();
          });
        },
        { isolationLevel: IsolationLevel.READ_COMMITTED },
      );
    } catch (error) {
      throw classifyPostgreSqlError(error);
    }

    // Após commit bem-sucedido da transação raiz, executa os callbacks pós-commit
    for (const callback of afterCommitCallbacks) {
      try {
        await callback();
      } catch (err) {
        console.error("Error executing afterCommit callback:", err);
      }
    }

    return result;
  }

  /**
   * Registra um callback para ser executado após o commit da transação raiz corrente.
   */
  public afterCommit(fn: () => void | Promise<void>): void {
    const context = MikroOrmUnitOfWork.storage.getStore();
    if (!context) {
      throw new Error(
        "Cannot register afterCommit callback outside an active UnitOfWork.run transaction.",
      );
    }
    context.afterCommitCallbacks.push(fn);
  }
}

