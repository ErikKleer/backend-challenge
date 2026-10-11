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
