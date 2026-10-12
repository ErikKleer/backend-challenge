import type { Wallet } from "../domain/wallet";

export interface WalletRepository {
  /**
   * Busca a carteira por identificador.
   * Retorna null se não encontrada.
   */
  findById(id: string): Promise<Wallet | null>;

  /**
   * Busca a carteira por identificador aplicando lock pessimista de linha (FOR UPDATE).
   * Deve ser executado dentro de uma transação ativa com lock_timeout configurado.
   * Retorna null se não encontrada.
   */
  findByIdForUpdate(id: string): Promise<Wallet | null>;

  /**
   * Insere a nova carteira caso não exista (ON CONFLICT DO NOTHING sobre player_id e currency ou id).
   * Retorna true se inserida com sucesso; false se já existia.
   */
  insertIfAbsent(wallet: Wallet): Promise<boolean>;

  /**
   * Atualiza o saldo e versão da carteira com guarda de concorrência otimista:
   * UPDATE wallets SET balance = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?
   * Se nenhuma linha for afetada, lança WalletVersionConflictError.
   */
  updateBalance(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export const WALLET_REPOSITORY_TOKEN = Symbol("WalletRepository");
