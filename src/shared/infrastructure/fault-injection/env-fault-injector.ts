import { closeSync, openSync } from "node:fs";
import { FaultPoint, type FaultInjector, NOOP_FAULT_INJECTOR } from "../../application/fault-injector.port";

export type FaultAction = "crash" | "crash_once";

export interface FaultSpec {
  point: FaultPoint;
  action: FaultAction;
}

const POINTS: ReadonlySet<string> = new Set(Object.values(FaultPoint));
const ACTIONS: ReadonlySet<string> = new Set<FaultAction>(["crash", "crash_once"]);

/** `FAULT_INJECTION="<ponto>=<crash|crash_once>"`, por exemplo `after_commit_before_ack=crash`. */
export function parseFaultSpec(value: string): FaultSpec {
  const [point, action, ...rest] = value.trim().split("=");
  if (!point || !action || rest.length > 0 || !POINTS.has(point) || !ACTIONS.has(action)) {
    throw new Error(
      `Invalid FAULT_INJECTION '${value}': expected '<${[...POINTS].join("|")}>=<${[...ACTIONS].join("|")}>'`,
    );
  }
  return { point: point as FaultPoint, action: action as FaultAction };
}

export interface EnvFaultInjectorOptions {
  /** Derruba o processo; injetável para testar o próprio injetor sem matar o runner. */
  kill?: () => void;
  /**
   * Arquivo-marca de `crash_once`: criado de forma atômica pelo primeiro processo que chega ao
   * ponto. Um processo que sobe depois o encontra e segue em frente (um reinício não repete a falha).
   */
  markerPath?: string;
}

function killSelf(): void {
  process.kill(process.pid, "SIGKILL");
}

/**
 * Implementação ativa só em teste. `crash` derruba o processo toda vez que o ponto é
 * alcançado; `crash_once` apenas na primeira vez entre todos os processos que compartilham
 * o `markerPath`. A morte é `SIGKILL`: sem handlers, sem flush, sem ack, como uma queda real.
 */
export class EnvFaultInjector implements FaultInjector {
  private readonly kill: () => void;

  constructor(
    private readonly spec: FaultSpec,
    private readonly options: EnvFaultInjectorOptions = {},
  ) {
    this.kill = options.kill ?? killSelf;
    if (spec.action === "crash_once" && !options.markerPath) {
      throw new Error("FAULT_INJECTION_MARKER is required for 'crash_once'");
    }
  }

  public reach(point: FaultPoint): void {
    if (point !== this.spec.point || !this.shouldFire()) {
      return;
    }
    this.kill();
  }

  private shouldFire(): boolean {
    if (this.spec.action === "crash") {
      return true;
    }
    try {
      // "wx" falha se o arquivo existe: só um processo vence a criação
      closeSync(openSync(this.options.markerPath!, "wx"));
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Fábrica do processo. Fora de `NODE_ENV=test` a variável é ignorada por completo, então um
 * `FAULT_INJECTION` esquecido num ambiente real não tem efeito.
 */
export function createFaultInjector(env: NodeJS.ProcessEnv = process.env): FaultInjector {
  if (env.NODE_ENV !== "test" || !env.FAULT_INJECTION) {
    return NOOP_FAULT_INJECTOR;
  }
  return new EnvFaultInjector(parseFaultSpec(env.FAULT_INJECTION), {
    markerPath: env.FAULT_INJECTION_MARKER,
  });
}
