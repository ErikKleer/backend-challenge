import { type CanActivate, type ExecutionContext, Inject } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { IS_PUBLIC_KEY } from "./public.decorator";

/**
 * Guard global **no-op**: sempre permite. Autenticação não está implementada
 * (README §2); este é o ponto de extensão explícito.
 *
 * Onde o guard real entraria: aqui. Ele validaria o token do Identity Provider
 * (assinatura, expiração, audiência) via `ProviderIdentityPort.resolve(request)` e
 * exigiria que o `providerId` do token seja igual ao `providerId` do corpo da
 * requisição, rejeitando com 401/403 caso contrário. Rotas `@Public()` seguem
 * abertas.
 */
export class AuthGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  public canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(
      IS_PUBLIC_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (isPublic) {
      return true;
    }

    // Guard real: `const identity = await this.identityPort.resolve(request)`,
    // negar se ausente ou se o providerId divergir do corpo.
    return true;
  }
}
