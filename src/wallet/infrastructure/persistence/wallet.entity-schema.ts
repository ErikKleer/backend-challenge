import { EntitySchema } from "@mikro-orm/core";

export interface WalletRow {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const WalletEntitySchema = new EntitySchema<WalletRow>({
  name: "WalletRow",
  tableName: "wallets",
  properties: {
    id: { type: "uuid", primary: true },
    playerId: { fieldName: "player_id", type: "string", columnType: "text" },
    currency: { fieldName: "currency", type: "string", columnType: "char(3)" },
    balance: { fieldName: "balance", type: "string", columnType: "numeric(19,2)" },
    version: { fieldName: "version", type: "integer", columnType: "integer", default: 1 },
    createdAt: { fieldName: "created_at", type: "Date", columnType: "timestamptz" },
    updatedAt: { fieldName: "updated_at", type: "Date", columnType: "timestamptz" },
  },
});
