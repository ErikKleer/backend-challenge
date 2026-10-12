import { EntitySchema } from "@mikro-orm/core";

export interface WalletLedgerEntryRow {
  id: string;
  walletId: string;
  transactionId: string;
  direction: string;
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
  walletVersion: number;
  createdAt: Date;
}

export const WalletLedgerEntryEntitySchema = new EntitySchema<WalletLedgerEntryRow>({
  name: "WalletLedgerEntryRow",
  tableName: "wallet_ledger_entries",
  properties: {
    id: { type: "uuid", primary: true },
    walletId: { fieldName: "wallet_id", type: "uuid" },
    transactionId: { fieldName: "transaction_id", type: "uuid" },
    direction: { fieldName: "direction", type: "string", columnType: "text" },
    amount: { fieldName: "amount", type: "string", columnType: "numeric(19,2)" },
    currency: { fieldName: "currency", type: "string", columnType: "char(3)" },
    balanceBefore: { fieldName: "balance_before", type: "string", columnType: "numeric(19,2)" },
    balanceAfter: { fieldName: "balance_after", type: "string", columnType: "numeric(19,2)" },
    walletVersion: { fieldName: "wallet_version", type: "integer", columnType: "integer" },
    createdAt: { fieldName: "created_at", type: "Date", columnType: "timestamptz" },
  },
});
