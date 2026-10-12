/**
 * Pontos do fluxo em que os testes podem derrubar o processo para provar a recuperação.
 * O código de produção só enxerga esta porta; a implementação padrão não faz nada.
 */
export enum FaultPoint {
  AfterCommitBeforeAck = "after_commit_before_ack", // mensagem SQS já commitada, ainda sem DeleteMessage
  AfterPublishBeforeCommit = "after_publish_before_commit", // evento enviado ao SQS, linha da outbox ainda sem marca
  AfterLedgerBeforeCommit = "after_ledger_before_commit", // lançamento gravado, transação SQL ainda aberta
}

export interface FaultInjector {
  /** Chamado no ponto indicado. Sem falha configurada para ele, retorna sem efeito. */
  reach(point: FaultPoint): void;
}

export const FAULT_INJECTOR_TOKEN = Symbol("FaultInjector");

export class NoopFaultInjector implements FaultInjector {
  public reach(): void {
    // Produção: nenhum custo além da chamada
  }
}

export const NOOP_FAULT_INJECTOR: FaultInjector = new NoopFaultInjector();
