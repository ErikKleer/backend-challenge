import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuthGuard } from "./auth.guard";
import { NoopProviderIdentity } from "./noop-provider-identity";
import { PROVIDER_IDENTITY_TOKEN } from "./provider-identity.port";

@Module({
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: PROVIDER_IDENTITY_TOKEN, useClass: NoopProviderIdentity },
  ],
  exports: [PROVIDER_IDENTITY_TOKEN],
})
export class AuthModule {}
