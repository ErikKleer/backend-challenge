import { type DynamicModule, Global, Module } from "@nestjs/common";
import { FAULT_INJECTOR_TOKEN } from "../../application/fault-injector.port";
import { createFaultInjector } from "./env-fault-injector";

/**
 * Global para que qualquer módulo receba o injetor sem importá-lo. Os consumidores o pedem
 * como `@Optional()`: um módulo montado sem este (testes de API) recebe o no-op.
 */
@Global()
@Module({})
export class FaultInjectionModule {
  public static forRoot(): DynamicModule {
    return {
      module: FaultInjectionModule,
      providers: [{ provide: FAULT_INJECTOR_TOKEN, useFactory: () => createFaultInjector() }],
      exports: [FAULT_INJECTOR_TOKEN],
    };
  }
}
