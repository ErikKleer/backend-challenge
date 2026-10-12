import type {
  ProviderIdentity,
  ProviderIdentityPort,
} from "./provider-identity.port";

/**
 * Implementação padrão enquanto a autenticação não existe: nenhuma requisição
 * carrega identidade.
 */
export class NoopProviderIdentity implements ProviderIdentityPort {
  public async resolve(_request: unknown): Promise<ProviderIdentity | undefined> {
    return undefined;
  }
}
