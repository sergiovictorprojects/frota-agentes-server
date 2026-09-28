# ADR 0002 — Ledger operacional auditável (agent_events)

## Status

Implementada na Fase 1 — Entrega 1.

## Contexto

`docs/EVENT_TAXONOMY.md` propõe um rascunho SQL inicial para `agent_events`, explicitamente marcado como
não aplicável sem comparação com as migrations reais. Ao implementar a Entrega 1 (migration
`002_agent_events.sql`, repositório `src/db/eventos.ts`, instrumentação em `src/orchestrator/*.ts` e
`src/http/ui/rotas.ts`), várias decisões concretas divergiram do rascunho ou precisaram ser resolvidas
pela primeira vez. Este ADR registra essas decisões.

## Decisões

### Cursor global + sequência por demanda, não um único `sequence`

`id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY` é a ordenação oficial de qualquer consulta —
`listarEventosDaDemanda`/`listarEventosDaRun` sempre ordenam por `id`. `sequencia_demanda` é mantida à
parte, só como número informativo por demanda (1, 2, 3...), útil para paginação de uma única timeline sem
depender do cursor global compartilhado por todas as demandas. Nenhuma consulta ordena por
`sequencia_demanda` ou por `tentativa`.

### Identidade de execução: `correlacao_id`, não `demandas.tentativas`

`demandas.tentativas` pode diminuir (`devolverParaFila(..., desfazerTentativa: true)`) ou zerar
(`reabrirDemanda`), então duas execuções diferentes podem legitimamente compartilhar o mesmo número de
tentativa. A identidade imutável de uma execução é `correlacao_id uuid NOT NULL`: o `run_id` real quando
existe uma run (sempre novo a cada `iniciarRun()`), ou um `randomUUID()` gerado uma única vez no início de
uma ação de interface sem run (criar, reabrir, responder). A chave de idempotência
(`chave_idempotencia`, única por `(demanda_id, chave_idempotencia)`) é derivada de `correlacao_id` +
`tipo_evento` — nunca de `tentativa`.

### `tentativa` nullable: reivindicar não é executar

Um evento só carrega um número em `tentativa` quando `registrarTentativa()` (o incremento real do
contador em `demandas`) já rodou antes dele. `demanda_reivindicada` e qualquer devolução para a fila antes
do processamento começar (`motivoDevolucao: 'nunca_iniciada'`) gravam `tentativa: null`; o número que a
tentativa teria, quando existe, fica em `metadata.tentativaPlanejada` — informativo, nunca prova de
execução.

### `ON DELETE RESTRICT`, não `CASCADE`

Um ledger append-only não pode desaparecer porque a demanda-mãe foi apagada. Hoje nada no código apaga
uma demanda de verdade (só "Arquivar", um `UPDATE` de status), então isso não deveria disparar em operação
normal — e se algo tentar, o histórico vence, não a exclusão.

### Resumo fixo por tipo de evento, metadata validada por schema por tipo (allowlist, não denylist)

`resumo` nunca é texto interpolado — é sempre um dos textos fixos de `RESUMOS_POR_TIPO`, indexado só pelo
`tipo_evento`. Nunca carrega título de demanda, plano do modelo, motivo/descrição de pendência, URL de
entrega ou mensagem de erro.

`metadata` é validada por um schema Zod `.strict()` específico do `tipo_evento`
(`METADATA_SCHEMAS`) antes do INSERT: cada tipo aceita só um conjunto exato de campos, com o tipo exato
(enums, UUIDs, contagens não-negativas, percentuais, booleans) — nunca texto livre. Isso substitui uma
lista de nomes de campo proibidos (denylist): uma denylist nunca pegaria `motivo` ou `descricao`
carregando texto livre do modelo, porque esses nomes não são intrinsecamente perigosos — só o valor livre
é. Uma allowlist por tipo torna o texto livre impossível de entrar, não apenas os nomes óbvios (`prompt`,
`chain_of_thought`, `api_key`...).

Erros nunca entram como `mensagemDeErro(erro)` — são classificados em um código fechado (`CodigoErro`:
`llm_recusa`, `llm_truncado`, `llm_invalido`, `llm_api`, `orcamento_excedido`, `frota_pausada`,
`claim_expirado`, `falha_inesperada`) por `codigoDoErro()` em `src/orchestrator/erros.ts`.

### Dual-write observacional e degradável, não transacional

Cada `registrarEvento()` roda na sua própria transação Postgres, separada da transação que persiste o
estado real (demanda/relatório/mensagem). Uma falha ao gravar o evento é logada e ignorada por quem chama
— nunca pode impedir nem atrasar o resultado real. Isso significa que, em casos raros (queda exatamente
entre as duas transações), o ledger pode ficar atrás do estado real ou perder um evento pontual. Ele não é
a fonte da verdade sobre o que aconteceu com a demanda — `demandas`/`relatorios`/`mensagens` continuam
sendo — é uma trilha auditável de apoio.

## Consequências

- Consultas e futuras integrações (dossiê, SSE) devem sempre ordenar por `id`, nunca por
  `sequencia_demanda` ou `ocorrido_em` isoladamente.
- Qualquer novo tipo de evento precisa de uma entrada em `RESUMOS_POR_TIPO` e `METADATA_SCHEMAS` antes de
  poder ser emitido — não há caminho para gravar metadata sem schema.
- `tentativa: null` é um estado válido e esperado, não um bug: código que consome `agent_events` (dossiê,
  métricas) precisa tratar esse caso.
- **`id` não é, por si só, um cursor sem perdas para SSE sob escritores concorrentes.** É estável para
  leitura pontual (mesma ordem sempre, para o mesmo conjunto de linhas já commitado) — suficiente para a
  timeline de uma demanda hoje. Mas um consumidor incremental por `WHERE id > cursor` pode pular uma linha
  cujo `id` foi reservado antes, mas cujo `COMMIT` aconteceu depois, do `id` que o cursor já ultrapassou
  (duas transações concorrentes em `registrarEvento` podem fazer commit fora de ordem de `id`). A Fase 5
  (SSE) não pode simplesmente consumir `agent_events` por cursor de `id`: vai exigir um outbox transacional
  (tabela de outbox gravada na mesma transação do evento, publicada de forma serializada) ou um único
  processo publicador serializado — ver a nota equivalente em `docs/EVENT_TAXONOMY.md`.

## Reversibilidade

Migration aditiva; nenhuma tabela existente foi alterada. Reverter significa apenas parar de emitir
eventos (os pontos de chamada em `processar-demanda.ts`/`processar-fila.ts`/`rotas.ts` já são fail-open) e,
se necessário, dropar `agent_events` — sem impacto nas tabelas de domínio.
