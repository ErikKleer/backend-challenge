# Arquitetura — Distributed Wagering Processor

## Visão Geral

Serviço financeiro distribuído de alta concorrência para processamento de apostas.

## Decisões (ADRs)

### ADR 1: Uso do MikroORM com EntitySchema

- **Contexto:** Necessidade de manter o domínio desacoplado de detalhes de banco de dados e ORMs.
- **Decisão:** Utilizar MikroORM com definição via `EntitySchema` e mappers manuais.
- **Consequências:** Isolamento completo do domínio em relação à persistência.

### ADR 2: Injeção de Dependência Explícita

- **Contexto:** O NestJS depende nativamente de reflexão (`emitDecoratorMetadata`), que pode conflitar com certas restrições do Bun ou arquiteturas puras.
- **Decisão:** Uso estrito de tokens explícitos (`@Inject(TOKEN)`).

### ADR 3: Emulador SQS via LocalStack

- **Contexto:** Necessidade de testar mensageria SQS FIFO localmente sem dependência de nuvem real.
- **Decisão:** Uso do LocalStack para SQS.


### ADR 4: Value Object Money com escala fixa e ausência de arredondamento

- **Contexto:** Cálculos financeiros sujeitos a erros de ponto flutuante binário (`number`) e inconsistências de arredondamento implícito violam a correção contábil do sistema.
- **Decisão:** Criamos o Value Object imutável `Money` utilizando uma instância isolada de `decimal.js` configurada sem arredondamentos implícitos (`ROUND_DOWN`, precisão 28). Nenhuma operação produz mais de 2 casas decimais. `Money.from` valida formato estrito `^-?(0|[1-9]\d{0,16})\.\d{2}$` (rejeitando `-0.00`, espaços, zeros à esquerda e notação científica), enquanto `Money.fromContract` rejeita estritamente valores negativos para entradas de borda (HTTP/SQS).
- **Consequências:** Garantia absoluta de precisão aritmética (`0.10 + 0.20 = 0.30`), imutabilidade estrutural e rejeição em tempo de execução de qualquer representação monetária ambígua.

### ADR 5: Versão da Wallet no Ledger (`walletVersion`) e integridade contábil

- **Contexto:** Toda alteração de saldo da `Wallet` precisa ser estritamente correlacionada a um lançamento de auditoria imutável, permitindo ordenação, concorrência e chave única para consistência.
- **Decisão:** Incluir `walletVersion: number` em `WalletLedgerEntry` representando a versão da carteira resultante da movimentação (`UNIQUE(wallet_id, wallet_version)`). O agregado `Wallet` incrementa sua versão estritamente quando o saldo muda (`debit` e `credit`) e emite o lançamento de ledger correspondente no mesmo ato. A factory `WalletLedgerEntry.create` verifica a igualdade estrita `balanceBefore ± money === balanceAfter`.
- **Consequências:** Impossibilidade de desvio entre o saldo da carteira e o histórico do ledger. Caso ocorra erro de saldo insuficiente (`InsufficientFundsError`), a carteira mantém seu estado original intocado.

### ADR 6: Máquina de estados de WagerTransaction, Política de Liquidação e Hash Canônico

- **Contexto:** Transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) requerem controle financeiro estrito, auditoria imutável de transições, resolução assíncrona de referências fora de ordem e deduplicação idempotente sem colisão de payloads.
- **Decisão:**
  1. **Máquina de Estados de `WagerTransaction`:**
     - Estados: `PENDING`, `PENDING_REFERENCE`, `PROCESSED`, `REJECTED`, `FAILED`.
     - Estados terminais imutáveis: `PROCESSED`, `REJECTED`, `FAILED`. Qualquer transição a partir de um estado terminal ou transição inválida lança `InvalidTransactionStateError`.
     - Tabela de transições válidas:
       | Estado Inicial | Evento / Método | Estado Destino | Condições |
       |---|---|---|---|
       | `(novo)` | `create(props)` | `PENDING` | REFUND/ROLLBACK exigem referência externa; money > 0 (LOSS >= 0) |
       | `PENDING` | `markProcessed(...)` | `PROCESSED` | Sucesso financeiro; grava `observedBalance` |
       | `PENDING` | `markPendingReference(...)`| `PENDING_REFERENCE` | Referência ausente ou ainda em processamento |
       | `PENDING` | `reject(code, ...)` | `REJECTED` | Rejeição de negócio; grava `observedBalance` |
       | `PENDING` | `fail(code)` | `FAILED` | Erro permanente de infraestrutura |
       | `PENDING_REFERENCE` | `scheduleReferenceRetry(...)` | `PENDING_REFERENCE` | Incrementa `referenceAttempts` e agenda nova data |
       | `PENDING_REFERENCE` | `markProcessed(...)` | `PROCESSED` | Referência processada com sucesso |
       | `PENDING_REFERENCE` | `reject(code, ...)` | `REJECTED` | Violação de regra ou tentativas esgotadas (`REFERENCE_NOT_FOUND`) |
       | `PENDING_REFERENCE` | `fail(code)` | `FAILED` | Erro permanente de infraestrutura |

  2. **Taxonomia de Códigos de Falha (`FailureCode`) e Ação Recomendada ao Provedor:**
     | FailureCode | Significado | Ação Sugerida ao Provedor |
     |---|---|---|
     | `INSUFFICIENT_FUNDS` | Saldo insuficiente para efetuar `BET` | Não reenviar; aguardar depósito do jogador |
     | `REVERSAL_WOULD_OVERDRAW` | Reversão (débito) deixaria saldo da carteira negativo | Intervenção manual / conciliação financeira |
     | `REFERENCE_NOT_FOUND` | Transação referenciada não encontrada após limite de retries | Reenviar após verificar status da transação de origem |
     | `REFERENCE_MISMATCH` | Inconsistência de player, wallet, moeda ou rodada com a referência | Corrigir payload da requisição antes de reenviar |
     | `REFERENCE_NOT_PROCESSED` | Transação de referência terminou em `REJECTED` ou `FAILED` | Não reenviar; transação de origem não possui efeito financeiro |
     | `INVALID_REFERENCE_KIND` | Tipo de operação referenciada incompatível com o tipo da reversão | Corrigir payload da requisição (verificar tipo da referência) |
     | `REFERENCE_AMOUNT_MISMATCH` | Valor do REFUND/ROLLBACK diferente do valor exato da referência | Corrigir payload com o valor exato da transação original |
     | `ALREADY_REVERSED` | Transação de referência já foi revertida anteriormente | Não reenviar; reversão já consumida |
     | `CURRENCY_MISMATCH` | Moeda da operação difere da moeda contratada da carteira | Corrigir payload com a moeda correspondente à carteira |
     | `PLAYER_WALLET_MISMATCH` | `playerId` informado na operação não é o proprietário da wallet | Corrigir payload associando o jogador correto |
     | `PERMANENT_INFRASTRUCTURE_ERROR` | Falha terminal de infraestrutura sem possibilidade de auto-recuperação | Intervenção manual da equipe de engenharia |

  3. **Interpretações Adotadas na Liquidação (`SettlementPolicy`):**
     - `WIN` e `LOSS` com referência opcional: Quando fornecida, a referência deve obrigatoriamente apontar para uma `BET` da mesma rodada, carteira e jogador.
     - Reversão única: Uma transação referenciada só pode ser revertida uma única vez (`existingReversal` bloqueia qualquer tentativa subsequente).
     - Referência pendente: Se a transação referenciada estiver `PENDING` ou `PENDING_REFERENCE`, a dependente entra/permanece em `PENDING_REFERENCE`.
     - Pureza: `SettlementPolicy` é puramente funcional e não aplica mutações em entidades ou agregados.

  4. **Algoritmo do `payloadHash`:**
     - Baseado em SHA-256 hex sobre representação canônica recursiva (`canonicalJson`).
     - Chaves de objetos são ordenadas lexicograficamente de forma recursiva; delimitadores sem espaços (`{"a":1,"b":2}`).
     - Propriedades com valor `null` ou `undefined` são estritamente omitidas.
     - Objetos monetários `Money` são canonicamente representados por `{ "amount": "xx.xx", "currency": "YYY" }`.
     - Campos participantes: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money`, `referenceExternalTransactionId` (quando presente).
     - Metadados de transporte (`Idempotency-Key`, `messageId`, headers HTTP, timestamps de fila) são excluídos do hash.
- **Consequências:** Integridade semântica determinística, auditoria inequívoca de transições e idempotência estrita independentemente do canal de ingestão (HTTP vs SQS).

