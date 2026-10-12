import { Module } from "@nestjs/common";
import { MikroOrmModule } from "@mikro-orm/nestjs";
import config from "../mikro-orm.config";
import { AuthModule } from "./auth/auth.module";
import { ObservabilityModule } from "./shared/infrastructure/observability/observability.module";
import { PersistenceModule } from "./shared/infrastructure/persistence/persistence.module";
import { PresentationModule } from "./shared/presentation/presentation.module";
import { WalletModule } from "./wallet/wallet.module";

/**
 * Tudo que serve HTTP, sem a infraestrutura (banco, logger). Os testes de API o
 * combinam com um `PersistenceModule` apontado para o banco de teste.
 */
@Module({
  imports: [AuthModule, PresentationModule, WalletModule],
})
export class ApiModule {}

@Module({
  imports: [
    MikroOrmModule.forRoot(config),
    PersistenceModule.forRoot(),
    ObservabilityModule.forRoot(),
    ApiModule,
  ],
})
class AppModuleCore {}

export const AppModule = AppModuleCore;
