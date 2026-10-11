export enum WagerTransactionKind {
  Opening = "OPENING",   // Interno: crédito de abertura da wallet
  Bet = "BET",           // Aposta (débito da wallet)
  Win = "WIN",           // Prêmio (crédito na wallet)
  Loss = "LOSS",         // Derrota (sem impacto financeiro)
  Refund = "REFUND",     // Reembolso de aposta (crédito)
  Rollback = "ROLLBACK", // Reversão de aposta/prêmio/reembolso (direção oposta)
}

export enum WagerTransactionStatus {
  Pending = "PENDING",                     // Aceita, ainda não aplicada
  PendingReference = "PENDING_REFERENCE", // Aguardando transação referenciada
  Processed = "PROCESSED",                 // Aplicada com sucesso (terminal)
  Rejected = "REJECTED",                   // Rejeitada por violação de regra de negócio (terminal)
  Failed = "FAILED",                       // Falha permanente de infraestrutura (terminal)
}

export enum FailureCode {
  InsufficientFunds = "INSUFFICIENT_FUNDS",                         // BET sem saldo suficiente
  ReversalWouldOverdraw = "REVERSAL_WOULD_OVERDRAW",                 // Reversão deixaria saldo negativo
  ReferenceNotFound = "REFERENCE_NOT_FOUND",                         // Referência não apareceu após esgotar tentativas
  ReferenceMismatch = "REFERENCE_MISMATCH",                         // Referência de outro player, wallet, moeda ou round
  ReferenceNotProcessed = "REFERENCE_NOT_PROCESSED",                 // Referência existe mas terminou REJECTED ou FAILED
  InvalidReferenceKind = "INVALID_REFERENCE_KIND",                   // Tipo de transação referenciada inválido para a operação
  ReferenceAmountMismatch = "REFERENCE_AMOUNT_MISMATCH",             // Valor da transação difere da referência
  AlreadyReversed = "ALREADY_REVERSED",                             // Referência já foi revertida anteriormente
  CurrencyMismatch = "CURRENCY_MISMATCH",                           // Moeda da operação difere da moeda da wallet
  PlayerWalletMismatch = "PLAYER_WALLET_MISMATCH",                   // playerId não é dono da wallet
  PermanentInfrastructureError = "PERMANENT_INFRASTRUCTURE_ERROR", // Erro terminal de infraestrutura (status FAILED)
}
