# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) de múltiplos provedores, por **HTTP** e por **AWS SQS**. Mantém o saldo de cada wallet consistente com um ledger imutável sob duplicatas, mensagens fora de ordem, concorrência entre instâncias e quedas de processo.

- Enunciado original do desafio: [docs/CHALLENGE.md](docs/CHALLENGE.md). Os comentários do código que citam `README §N` se referem a esse arquivo.
- Arquitetura, decisões (ADRs), trade-offs e limitações: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

**Stack:** Bun 1.x · TypeScript estrito · NestJS · PostgreSQL 16 · MikroORM · SQS via LocalStack · Docker Compose · `decimal.js`, `zod`, `pino`, `prom-client`.

## Pré-requisitos

- [Bun](https://bun.sh) 1.x
- Docker com Docker Compose v2 (PostgreSQL e LocalStack rodam em contêineres)
- Portas livres: `5432` (PostgreSQL), `4566` (LocalStack) e `3000` (aplicação local)

## Setup passo a passo (desenvolvimento local)

```bash
bun install
cp .env.example .env          # valores padrão já apontam para localhost
bun run infra:up              # PostgreSQL + LocalStack + provisionamento das filas
bun run migration:up          # cria o schema
bun run start:dev             # API em http://localhost:3000 (com --watch)
```

`infra:up` sobe `postgres` e `localstack`, espera ficarem saudáveis e executa o serviço `provision`, que cria as filas `wager-transactions.fifo`, `wager-transactions-dlq.fifo` (com redrive policy) e `wager-events.fifo`. É idempotente.

Teste rápido:

```bash
curl -s http://localhost:3000/health/ready
# {"status":"ok","checks":{"postgres":"up","sqs":"up"}}
```

Para parar: `bun run infra:down` (mantém os dados) ou `bun run infra:reset` (apaga os volumes).

## Subir com 3 instâncias (Docker Compose)

Tudo em contêineres, incluindo migrations e provisionamento (serviços `migrate` e `provision`, executados antes das instâncias):

```bash
docker compose --profile app up --build --scale app=3
```

As três instâncias compartilham o mesmo PostgreSQL e as mesmas filas. Cada uma recebe uma **porta aleatória** no host. Para descobri-las:

```bash
docker compose port --index 1 app 3000
docker compose port --index 2 app 3000
docker compose port --index 3 app 3000
# ou: docker compose --profile app ps app
```

O `healthcheck` do Compose usa `GET /health/live` (liveness). Uma queda do PostgreSQL ou do SQS não reinicia o contêiner; use `GET /health/ready` como readiness probe em um orquestrador.

> Se o `docker` não estiver no `PATH` do seu shell (por exemplo, instalado só dentro do WSL no Windows), execute os mesmos comandos pelo WSL.

## Papéis por variável de ambiente

Toda instância pode exercer todos os papéis, e é seguro rodar vários de cada (o trabalho é particionado no banco). Cada papel liga ou desliga por variável, o que permite, por exemplo, instâncias só de API e instâncias só de workers:

| Variável | Papel | Padrão |
|---|---|---|
| `ENABLE_SQS_CONSUMER` | consome `wager-transactions.fifo` | `true` |
| `ENABLE_OUTBOX_PUBLISHER` | publica a outbox em `wager-events.fifo` | `true` |
| `ENABLE_PENDING_WORKER` | reprocessa transações `PENDING_REFERENCE` | `true` |

`ENABLE_HTTP` existe no schema de configuração, mas ainda não é consumida: a API HTTP sempre sobe (ver limitações no `ARCHITECTURE.md`). Valores `false`, `0`, `no`, `off` e vazio desligam um papel.

## Variáveis de ambiente

Modelo em [.env.example](.env.example). A aplicação valida tudo com `zod` na partida e não sobe com configuração inválida.

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3000` | porta HTTP |
| `DATABASE_URL` | — (obrigatória) | conexão PostgreSQL |
| `DB_POOL_MAX` | `10` | tamanho máximo do pool; limita as transações simultâneas |
| `DB_LOCK_TIMEOUT_MS` | `2000` | `lock_timeout` de cada transação (lock da wallet) |
| `AWS_REGION` / `AWS_ENDPOINT` | `us-east-1` / — | região e endpoint do SQS (LocalStack: `http://localhost:4566`) |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | `dummy` | credenciais (qualquer valor no LocalStack) |
| `SQS_QUEUE_WAGER_TRANSACTIONS` | — (obrigatória) | fila de entrada |
| `SQS_QUEUE_WAGER_TRANSACTIONS_DLQ` | — (obrigatória) | DLQ da fila de entrada |
| `SQS_QUEUE_WAGER_EVENTS` | — (obrigatória) | fila de saída (eventos de integração) |
| `SQS_REQUEST_TIMEOUT_MS` | `3000` | timeout do cliente SQS do publisher e dos health checks |
| `SQS_WAIT_SECONDS` | `10` | long polling do consumidor |
| `SQS_MAX_MESSAGES` | `10` | mensagens por `ReceiveMessage` |
| `SQS_CONSUMER_CONCURRENCY` | `5` | handlers simultâneos por instância |
| `SQS_RETRY_BASE_SECONDS` / `SQS_RETRY_MAX_SECONDS` | `2` / `60` | backoff do retry de falha transitória |
| `SQS_MAX_RECEIVE_COUNT` | `5` | entregas antes da DLQ (igual à redrive policy provisionada) |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | prazo para concluir mensagens em andamento no `SIGTERM` |
| `HEALTH_CHECK_TIMEOUT_MS` | `2000` | prazo de cada dependência no `/health/ready` |
| `LOG_LEVEL` | `info` | nível do `pino` |
| `PENDING_REFERENCE_BASE_DELAY_MS` / `_MAX_DELAY_MS` / `_MAX_ATTEMPTS` | `2000` / `60000` / `8` | backoff do reprocessamento de referências pendentes (≈ 4 min no total) |
| `PENDING_WORKER_POLL_INTERVAL_MS` / `PENDING_WORKER_BATCH_SIZE` | `1000` / `20` | laço do worker de pendentes |
| `OUTBOX_POLL_INTERVAL_MS` / `OUTBOX_BATCH_SIZE` | `500` / `10` | laço do publisher da outbox |
| `ENABLE_SQS_CONSUMER`, `ENABLE_OUTBOX_PUBLISHER`, `ENABLE_PENDING_WORKER` | `true` | papéis (ver acima) |

Somente em testes (`NODE_ENV=test`): `FAULT_INJECTION="<ponto>=<crash|crash_once>"` derruba o processo em pontos definidos. Fora de `NODE_ENV=test` é ignorada (ADR 27).

## Comandos

| Comando | O que faz |
|---|---|
| `bun run start` / `bun run start:dev` | sobe a aplicação / com `--watch` |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run test` | as três suítes abaixo em sequência |
| `bun run test:unit` | domínio e lógica pura, sem I/O |
| `bun run test:integration` | PostgreSQL e LocalStack reais |
| `bun run test:concurrency` | paralelismo real, incluindo testes com processos filhos e `SIGKILL` |
| `bun run migration:up` / `migration:down` | aplica / reverte a última migration |
| `bun run migration:create` | gera uma migration (MikroORM) |
| `bun run infra:up` | PostgreSQL + LocalStack + filas |
| `bun run infra:down` / `infra:reset` | para a infraestrutura / para e apaga os volumes |
| `bun run infra:provision` | (re)cria as filas |

As suítes de integração e concorrência precisam da infraestrutura no ar (`bun run infra:up`) e **não** usam mocks de PostgreSQL ou SQS. Cada arquivo de teste cria o próprio banco temporário e as próprias filas, então não interferem entre si. Resultado de referência: unitários ≈ 250 testes, integração ≈ 270, concorrência ≈ 35; a execução completa leva cerca de 3 minutos.

## Endpoints e exemplos

Valores monetários são sempre strings decimais com **exatamente 2 casas** (`"25.00"`). Um `number` JSON é rejeitado com 400. Em todos os erros o corpo é `{ "error": { "code", "message", "details"? }, "correlationId" }`; envie `X-Correlation-Id` para propagar o seu.

Nos exemplos, `W` é o `id` da wallet e `P` o `playerId`.

```bash
BASE=http://localhost:3000
P=$(cat /proc/sys/kernel/random/uuid)   # qualquer UUID/texto identifica o jogador
```

### Criar wallet — `POST /wallets`

```bash
curl -s -X POST $BASE/wallets -H 'Content-Type: application/json' \
  -d "{\"playerId\":\"$P\",\"initialBalance\":{\"amount\":\"100.00\",\"currency\":\"BRL\"}}"
# 201 {"id":"<W>","playerId":"...","balance":{"amount":"100.00","currency":"BRL"},"version":1}
```

Repetir o mesmo `playerId` + `currency` devolve **409** `WALLET_ALREADY_EXISTS`. O saldo inicial gera uma transação interna `OPENING` e um lançamento `CREDIT` no ledger, na mesma transação SQL.

### Submeter transação — `POST /wagering/transactions`

O header `Idempotency-Key` é obrigatório (padrão recomendado: `{providerId}:{externalTransactionId}`).

```bash
W=<id da wallet>
curl -s -i -X POST $BASE/wagering/transactions \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: provider-a:bet-1' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"bet-1\",\"playerId\":\"$P\",\"walletId\":\"$W\",\"roundId\":\"round-1\",\"gameId\":\"fortune-chimp\",\"kind\":\"BET\",\"money\":{\"amount\":\"80.00\",\"currency\":\"BRL\"}}"
# 201 {"transactionId":"...","status":"PROCESSED","balance":{"amount":"20.00","currency":"BRL"},"idempotentReplay":false}
```

**Replay** (mesma chave e mesmo payload, em qualquer instância): devolve o resultado original, inclusive o saldo observado na época.

```bash
# repetir exatamente o comando acima
# 200 {"transactionId":"<o mesmo>","status":"PROCESSED","balance":{"amount":"20.00",...},"idempotentReplay":true}
```

**Conflito de idempotência** (mesma chave, payload diferente, por exemplo `"amount":"10.00"`):

```bash
# 409 {"error":{"code":"IDEMPOTENCY_CONFLICT","message":"Idempotency key 'provider-a:bet-1' was already used with a different payload"},...}
```

**Rejeição por regra de negócio** (nova aposta de `80.00` com saldo `20.00`):

```bash
# 422 {"transactionId":"...","status":"REJECTED","balance":{"amount":"20.00",...},"idempotentReplay":false,"failureCode":"INSUFFICIENT_FUNDS"}
```

**Reversão** com `REFUND` (ou `ROLLBACK`): informe `referenceExternalTransactionId`, com o valor exato da referência.

```bash
curl -s -i -X POST $BASE/wagering/transactions \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: provider-a:refund-1' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"refund-1\",\"playerId\":\"$P\",\"walletId\":\"$W\",\"roundId\":\"round-1\",\"gameId\":\"fortune-chimp\",\"kind\":\"REFUND\",\"money\":{\"amount\":\"80.00\",\"currency\":\"BRL\"},\"referenceExternalTransactionId\":\"bet-1\"}"
# 201 PROCESSED, saldo de volta a 100.00
```

Se a referência ainda não existe, a resposta é **202** `PENDING_REFERENCE`: o worker reprocessa com backoff e, se a referência nunca chegar, a transação termina `REJECTED` com `REFERENCE_NOT_FOUND`. Reenviar a mesma chave devolve o status atual.

Sem o header: **400** `MISSING_IDEMPOTENCY_KEY`. Payload inválido (campo ausente, `amount` numérico, 3 casas decimais, `kind: "OPENING"`): **400** `VALIDATION_ERROR` com `details` por campo.

Mapeamento completo:

| Situação | Status | Código / corpo |
|---|---|---|
| `PROCESSED`, primeira vez | 201 | `status: "PROCESSED"` |
| Replay | 200 processada · 202 pendente · 422 rejeitada | `idempotentReplay: true` |
| `PENDING_REFERENCE` | 202 | `status: "PENDING_REFERENCE"` |
| `REJECTED` | 422 | `status: "REJECTED"`, `failureCode` |
| Payload inválido / sem header | 400 | `VALIDATION_ERROR` · `MISSING_IDEMPOTENCY_KEY` |
| Conflito de idempotência | 409 | `IDEMPOTENCY_CONFLICT` |
| Wallet duplicada | 409 | `WALLET_ALREADY_EXISTS` |
| Wallet ou transação inexistente | 404 | `WALLET_NOT_FOUND` · `TRANSACTION_NOT_FOUND` |
| Falha transitória (lock timeout, deadlock, banco fora) | 503 + `Retry-After` | `TRANSIENT_FAILURE` (**pode repetir a mesma requisição**) |
| Inesperado | 500 | `INTERNAL_ERROR` |

### Consultas

```bash
curl -s $BASE/wallets/$W
# {"id":"...","playerId":"...","balance":{"amount":"100.00","currency":"BRL"},"version":3}

curl -s "$BASE/wallets/$W/ledger?limit=50"          # keyset; devolve nextCursor opaco
curl -s "$BASE/wallets/$W/ledger?limit=50&cursor=<nextCursor>"

curl -s $BASE/wagering/transactions/<transactionId>
curl -s $BASE/providers/provider-a/wagering/transactions/bet-1
```

O `balance` das consultas de transação é o saldo **observado** na decisão (o mesmo que o replay devolve), não o saldo corrente. `limit` vai de 1 a 200 (padrão 50).

### Reconciliação — `POST /wallets/:walletId/reconciliation`

Compara o saldo armazenado com o saldo reconstruído pelo ledger. Divergências **não** são corrigidas: são logadas, contadas em `reconciliation_divergences_total` e sinalizadas na resposta.

```bash
curl -s -X POST $BASE/wallets/$W/reconciliation
# {"walletId":"...","storedBalance":{"amount":"100.00",...},"calculatedBalance":{"amount":"100.00",...},
#  "difference":{"amount":"0.00","currency":"BRL"},"consistent":true,"checkedEntries":3}
```

### Health e métricas (abertos)

```bash
curl -s $BASE/health/live      # 200 {"status":"ok"}
curl -s $BASE/health/ready     # 200 {"status":"ok","checks":{"postgres":"up","sqs":"up"}} · 503 se uma dependência cai
curl -s $BASE/metrics          # Prometheus
```

### Enviar pela fila SQS

O consumidor usa o mesmo caso de uso do HTTP. Mensagem (corpo JSON) para `wager-transactions.fifo`, com `MessageGroupId` (sugestão: `walletId`) e `MessageDeduplicationId`:

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-07-29T15:00:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "idempotencyKey": "provider-a:transaction-123",
    "playerId": "...", "walletId": "...", "roundId": "round-987", "gameId": "fortune-chimp",
    "kind": "BET", "money": { "amount": "25.00", "currency": "BRL" }
  }
}
```

Mensagens inválidas, `OPENING`, wallet inexistente e `messageId` repetido com conteúdo diferente vão para `wager-transactions-dlq.fifo`; falhas transitórias são reentregues com backoff. Eventos de saída (`WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged`, `WagerTransactionPendingReference`) saem em `wager-events.fifo`.

## Estrutura de pastas

```
src/
  main.ts, app.module.ts
  shared/        Money, erros de domínio, portas (Clock, IdGenerator, UnitOfWork), persistência (MikroORM),
                 observabilidade (logs, métricas, contexto), config, filtro de exceções, injeção de falhas
  wallet/        agregado Wallet, ledger imutável, criação, consultas, reconciliação
  wagering/      WagerTransaction, SettlementPolicy, SubmitWagerTransaction, worker de pendentes,
                 consumidor SQS (handler, classificação de erros), controllers
  messaging/     eventos de integração, inbox/outbox, publisher da outbox, cliente e poller SQS
  health/        liveness e readiness
  auth/          AuthGuard no-op e ProviderIdentityPort (ponto de extensão)
migrations/      migrations versionadas e reversíveis
scripts/         migrate.ts, provision-queues.ts
test/
  unit/          domínio e lógica pura
  integration/   PostgreSQL e LocalStack reais
  concurrency/   paralelismo real e processos filhos
  support/       barreira de início, polling, harness de processos, invariantes
docs/            ARCHITECTURE.md, CHALLENGE.md
```

Cada módulo segue `domain` (puro, sem Nest nem ORM) → `application` (casos de uso e portas) → `infrastructure` / `presentation` (adaptadores).

## Documentação

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): visão geral, modelo de dados, concorrência e alternativas descartadas, idempotência, máquina de estados, taxonomia de `FailureCode`, inbox/outbox/DLQ, observabilidade, rastreabilidade (restrições invioláveis e falhas eliminatórias ⇒ código ⇒ teste), limitações e ADRs 1–27.
- [docs/CHALLENGE.md](docs/CHALLENGE.md): enunciado original.
