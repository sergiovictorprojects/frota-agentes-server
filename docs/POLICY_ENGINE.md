# Policy Engine

## Status desta entrega (Fase 2 — Entrega 2)

Implementado: um motor de avaliação de políticas **determinístico** (sem LLM, sem código arbitrário, sem
expressões livres), rodando em **modo shadow** — avalia e registra decisões em três pontos do fluxo real
(antes da execução, antes da auditoria, depois do resultado), mas **nunca bloqueia, pausa ou exige
aprovação de verdade**. Nenhum status de demanda é alterado por este motor nesta entrega.

**Não implementado nesta entrega** (alvo futuro, fora de escopo aqui):
- bloqueio real (modo enforce) — `deny` é registrado, nunca impede a chamada ao modelo;
- aprovações humanas de verdade — `require_approval` é registrado, nunca pausa a demanda nem cria uma
  fila de aprovação;
- UI de administração de políticas — criar/ativar/desativar políticas e regras hoje é só via as funções do
  repositório (`src/db/politicas.ts`), chamadas por script/console, nunca por uma rota HTTP;
- qualquer política real pré-carregada — **o catálogo de regras vazio é intencional**: nenhuma política é
  seedada no boot, e sem regra ativa o motor decide `allow` por padrão. Em modo shadow isso é o
  comportamento esperado: a trilha (`avaliacoes_politica` e `politica_avaliada` no ledger) já é gravada em
  toda execução, e as primeiras regras serão criadas de forma deliberada, revisadas e observadas em shadow
  antes de qualquer enforcement — nunca como efeito colateral de um deploy;
- mais visibilidade de políticas no dossiê — o dossiê já mostra o evento seguro `politica_avaliada` na
  linha do tempo (estágio, decisão, ids e versão da regra); uma seção própria de políticas no dossiê
  (lendo `avaliacoes_politica`) fica como escopo futuro.

Ver `docs/adr/0004-policy-engine-shadow.md` para o raciocínio completo por trás de "shadow antes de
enforcement".

## Modelo de dados

Migration `004_policy_engine.sql` — quatro tabelas, nenhuma alteração em tabela existente.

### `politicas`

Um agrupamento nomeado de regras. `id`/`chave`/`nome`/`descricao` são **imutáveis** (sem rota de
administração nesta entrega, o banco bloqueia qualquer `UPDATE` nesses campos). `estado`
(`ativa`/`inativa`) é o único campo editável — desativar uma política desativa, de uma vez, todas as suas
regras (elas não têm estado próprio, ver abaixo).

### `politicas_historico`

Trilha append-only de mudanças de `estado` — mesmo mecanismo comprovado em `agentes`/`agentes_historico`
(Fase 2, Entrega 1): o gatilho `politicas_controlar_mudancas` grava a trilha e incrementa `versao` como
parte do próprio `UPDATE`, para qualquer caminho que chegue à tabela (`atualizarPolitica()` ou SQL
direto) — não é uma permissão que se possa burlar, porque não há permissão nenhuma a burlar. Ver a seção
"Identidade imutável e trilha obrigatória" do `docs/AGENT_CATALOG.md` para o detalhe completo do
mecanismo (idêntico aqui).

### `regras_politica`

**Totalmente append-only** — nenhum campo é editável, nem mesmo `estado` (rules não têm). Mudar uma
condição ou decisão é criar uma regra nova (novo `id`/`chave`), nunca editar uma existente. Um gatilho
bloqueia `UPDATE`/`DELETE` diretos (mesmo padrão de `agent_events`).

Cada regra tem:
- `estagio`: `pre`, `during` ou `post`;
- `decisao`: `allow`, `warn`, `require_approval` ou `deny`;
- `condicao`: um objeto jsonb **allowlist** — só sete campos possíveis, cada um com um domínio fechado já
  usado em outro lugar do sistema:

  | Campo | Domínio |
  |---|---|
  | `agente` | identificador validado `^[a-z0-9][a-z0-9._:-]{0,99}$` (normalmente a `chave` de um agente, `agentes.chave`), nunca texto livre — **não** é chave estrangeira obrigatória para `agentes` (ver "Agente fora do catálogo" abaixo) |
  | `papel` | `coordenador`, `executor`, `avaliador`, `auditor` |
  | `categoria` | um dos 19 valores de `Categoria` (`gestores`, `d1`..`d18`) — sempre a categoria **da demanda**, inclusive no estágio de auditoria (permite filtrar políticas de auditoria pelo tipo de demanda) |
  | `estado` | `ativo`, `suspenso`, `sob_demanda` (o estado do agente) ou `desconhecido` (agente fora do catálogo — ver abaixo) |
  | `modelo` | o modelo permitido/chamado — identificador no mesmo formato de `agente` |
  | `operacao` | `execucao`, `auditoria`, `planejamento` (a chamada do coordenador que propõe o plano de tarefas, só com `ORQUESTRACAO_TAREFAS=planejar`) ou `integracao` (reservado para a entrega 3.2). Os dois últimos entraram pela migration 005 — ver ADR 0006 |
  | `prioridade` | `CRITICAL`, `HIGH`, `MEDIUM`, `LOW` |

  Todos os campos são opcionais; uma condição casa com um contexto quando **todo campo presente na
  condição** é igual ao campo correspondente do contexto (campos ausentes na condição são "qualquer
  valor"). Isto é o que torna o motor "sem LLM, sem código arbitrário, sem expressões livres": uma
  condição nunca é uma função nem uma string interpretada — é só um objeto raso de igualdade.

  **Validação em duas camadas, com a mesma regra:** o schema Zod `.strict()` em `src/db/politicas.ts`
  (`CondicaoSchema`) e o `CHECK (politica_condicao_valida(condicao))` na migration. O `CHECK` faz o banco
  rejeitar, mesmo num `INSERT` por SQL direto: JSON que não seja objeto; campo fora da allowlist; valor que
  não seja string (objeto aninhado, array, número, booleano, `null`); valor fora do domínio fechado de cada
  campo; e texto livre em `agente`/`modelo`. Uma regra inválida, portanto, não entra no banco por nenhum
  caminho normal. `test/db/politicas.test.ts` tenta inserir por SQL direto cada caso inválido (e cada
  valor válido de cada domínio), o que também pega qualquer divergência entre a lista do banco e a do Zod.

  **Agente fora do catálogo:** se o agente avaliado não existe em `agentes`, o contexto recebe
  `estado: "desconhecido"` — nunca `ativo`. Assim uma regra com `estado: "ativo"` nunca casa com um agente
  inexistente, e uma política pode mirar `estado: "desconhecido"` explicitamente. `desconhecido` existe só
  no vocabulário de políticas: `agentes.estado` continua aceitando apenas `ativo`, `suspenso` e
  `sob_demanda`. É exatamente por isso que `agente` é um identificador validado e não uma chave
  estrangeira: `desconhecido` só faz sentido para uma chave ausente do catálogo (que hoje nasce vazio).
  Nesse caso o `papel` vem do ponto do fluxo, não do catálogo: na execução, `papelDoSetor(categoria da
  demanda)`; na auditoria, sempre `auditor`. Com o agente cadastrado, `papel` e `estado` vêm sempre do
  catálogo.

### `avaliacoes_politica`

O log append-only de cada avaliação, em modo shadow. Cursor global (`id bigint identity`), mesmo padrão de
`agent_events`. Cada linha registra `demanda_id`, `run_id`, `regra_id`/`politica_id` (ambos `NULL` juntos
quando nenhuma regra ativa casou — a decisão implícita `allow` ainda é registrada, para completude
observacional), `estagio`, `decisao`, `contexto` (o mesmo formato fechado da condição — nunca texto livre
da demanda, validado pelo mesmo `CHECK` da condição e exigindo os sete campos) e `versao_regra` (snapshot
da versão da regra no momento da avaliação). Um gatilho bloqueia `UPDATE`/`DELETE` diretos.

## O motor: determinístico, sem LLM

`avaliarEregistrar()` (`src/db/politicas.ts`):

1. Busca as regras **ativas** (`regras_politica.estagio = <estágio>` cuja `politicas.estado = 'ativa'`)
   para o estágio pedido.
2. Filtra as que **casam** com o contexto (igualdade em todo campo presente na condição).
3. Entre as que casam, a **mais restritiva vence** — ordem de severidade `allow < warn < require_approval
   < deny`. Um sinal conservador mesmo em modo shadow, onde nada é de fato bloqueado.
4. Sem regra correspondente: decisão implícita `allow`, `regra_id`/`politica_id` nulos.
5. Grava a avaliação em `avaliacoes_politica` e emite um evento `politica_avaliada` no ledger unificado
   (`agent_events`) — só `estagio`, `decisao`, `politicaId`, `regraId` e `versaoRegra`, nunca a condição da
   regra, o nome da política ou qualquer texto (ver `METADATA_SCHEMAS['politica_avaliada']` em
   `src/db/eventos.ts`).

Nenhum passo usa um modelo de linguagem. Não há caminho para uma "condição" conter código a ser executado
— o Zod rejeita qualquer campo fora da allowlist antes de a regra chegar ao banco, e o `CHECK` rejeita no
próprio banco o que chegar por outro caminho.

**Fail-open, nunca bloqueia**: `avaliarEregistrar()` nunca lança, e `avaliarEstagio()` no orquestrador
também é fail-open por inteiro (inclusive a leitura do agente no catálogo, feita antes da avaliação — sem
isso, uma falha nessa leitura no estágio `post`, que roda com a demanda já Concluída, devolveria a demanda
para a fila). O fail-open existe para indisponibilidade ou corrupção inesperada (banco fora do ar, linha
adulterada): a falha é logada (`erro_avaliacao_politica`) e ignorada — o mesmo espírito fail-open do
ledger de eventos (`registrarEvento`, Fase 1). Uma regra inválida não é um desses casos: ela é barrada na
entrada pelo `CHECK`. Quem chama (o orquestrador) nunca ramifica no valor retornado para
alterar o fluxo da demanda; o retorno existe só para quem quiser inspecionar/logar, nunca para decidir.

## Integração no orquestrador (shadow — três pontos)

`src/orchestrator/processar-demanda.ts` chama `avaliarEstagio()` (que busca o agente no catálogo e monta o
contexto) em três pontos:

| Estágio | Onde | `operacao` |
|---|---|---|
| `pre` | Início de `processarDemanda`, antes de qualquer chamada ao modelo de execução | `execucao` |
| `during` | Início de `auditar()`, antes do laço de tentativas de auditoria | `auditoria` |
| `post` | Depois do resultado — nos dois retornos antecipados de `tratarPendencia` (ação humana, insumo B) **e** no retorno final de `processarDemanda` | `execucao` |

Com `ORQUESTRACAO_TAREFAS=planejar`, o planejamento (`src/orchestrator/planejamento.ts`) acrescenta seus
próprios `pre`, `during` e `post`, com `operacao: planejamento` e o agente `frota:gestores`, antes da execução.
Como acontecem na mesma run e com os mesmos estágios, o evento `politica_avaliada` dessas avaliações leva a
operação na chave de idempotência (`planejamento:pre`) e no metadata (`operacao`); as operações legadas
continuam com a chave só pelo estágio.

Em nenhum dos três pontos o resultado de `avaliarEstagio()` é usado para decidir o que fazer — a chamada é
puramente observacional, exatamente como uma emissão de evento no ledger. Nenhum prompt foi alterado,
nenhuma lógica de fila (`processar-fila.ts`) foi tocada, nenhuma aprovação é exigida, nenhum status de
demanda muda por causa de uma avaliação de política.

## Por que "shadow" nesta entrega

Ver `docs/adr/0004-policy-engine-shadow.md` para a decisão completa. Em resumo: um motor de bloqueio real
precisa de confiança prévia de que suas regras não vão travar produção por um falso positivo — rodar em
shadow primeiro, observando decisões reais sem agir sobre elas, é como se constrói essa confiança antes de
ativar `enforce`.
