/**
 * Identidade do provedor extraída de uma requisição autenticada.
 */
export interface ProviderIdentity {
  providerId: string;
}

export interface ProviderIdentityPort {
  /**
   * Resolve a identidade do provedor a partir da requisição (por exemplo, o token do IdP).
   * Retorna `undefined` quando a requisição não carrega identidade.
   */
  resolve(request: unknown): Promise<ProviderIdentity | undefined>;
}

export const PROVIDER_IDENTITY_TOKEN = Symbol("ProviderIdentityPort");
