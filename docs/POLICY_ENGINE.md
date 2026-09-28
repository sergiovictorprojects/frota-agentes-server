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
- qualquer política real pré-carregada — nenhuma política é seedada no boot; o catálogo de políticas
  nasce vazio, e o motor em produção hoje sempre decide `allow` (nenhuma regra ativa existe até alguém
  criar uma).

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
  | `agente` | a `chave` de um agente no catálogo (`agentes.chave`) |
  | `papel` | `coordenador`, `executor`, `avaliador`, `auditor` |
  | `categoria` | um dos 19 valores de `Categoria` (`gestores`, `d1`..`d18`) |
  | `estado` | `ativo`, `suspenso`, `sob_demanda` (o estado do agente) |
  | `modelo` | o modelo permitido/chamado |
  | `operacao` | `execucao` ou `auditoria` — os dois únicos pontos do fluxo real que chamam um modelo |
  | `prioridade` | `CRITICAL`, `HIGH`, `MEDIUM`, `LOW` |

  Todos os campos são opcionais; uma condição casa com um contexto quando **todo campo presente na
  condição** é igual ao campo correspondente do contexto (campos ausentes na condição são "qualquer
  valor"). Isto é o que torna o motor "sem LLM, sem código arbitrário, sem expressões livres": uma
  condição nunca é uma função nem uma string interpretada — é só um objeto raso de igualdade, validado por
  um schema Zod `.strict()` (e por um `CHECK` correspondente na migration).

### `avaliacoes_politica`

O log append-only de cada avaliação, em modo shadow. Cursor global (`id bigint identity`), mesmo padrão de
`agent_events`. Cada linha registra `demanda_id`, `run_id`, `regra_id`/`politica_id` (ambos `NULL` juntos
quando nenhuma regra ativa casou — a decisão implícita `allow` ainda é registrada, para completude
observacional), `estagio`, `decisao`, `contexto` (o mesmo formato fechado da condição — nunca texto livre
da demanda) e `versao_regra` (snapshot da versão da regra no momento da avaliação). Um gatilho bloqueia
`UPDATE`/`DELETE` diretos.

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
— o schema Zod `.strict()` rejeita qualquer campo fora da allowlist antes de a regra chegar ao banco.

**Fail-open, nunca bloqueia**: `avaliarEregistrar()` nunca lança. Uma falha ao gravar (banco fora do ar,
erro de validação) é logada e ignorada, retornando `allow` — o mesmo espírito fail-open do ledger de
eventos (`registrarEvento`, Fase 1). Quem chama (o orquestrador) nunca ramifica no valor retornado para
alterar o fluxo da demanda; o retorno existe só para quem quiser inspecionar/logar, nunca para decidir.

## Integração no orquestrador (shadow — três pontos)

`src/orchestrator/processar-demanda.ts` chama `avaliarEstagio()` (que busca o agente no catálogo e monta o
contexto) em três pontos:

| Estágio | Onde | `operacao` |
|---|---|---|
| `pre` | Início de `processarDemanda`, antes de qualquer chamada ao modelo de execução | `execucao` |
| `during` | Início de `auditar()`, antes do laço de tentativas de auditoria | `auditoria` |
| `post` | Depois do resultado — nos dois retornos antecipados de `tratarPendencia` (ação humana, insumo B) **e** no retorno final de `processarDemanda` | `execucao` |

Em nenhum dos três pontos o resultado de `avaliarEstagio()` é usado para decidir o que fazer — a chamada é
puramente observacional, exatamente como uma emissão de evento no ledger. Nenhum prompt foi alterado,
nenhuma lógica de fila (`processar-fila.ts`) foi tocada, nenhuma aprovação é exigida, nenhum status de
demanda muda por causa de uma avaliação de política.

## Por que "shadow" nesta entrega

Ver `docs/adr/0004-policy-engine-shadow.md` para a decisão completa. Em resumo: um motor de bloqueio real
precisa de confiança prévia de que suas regras não vão travar produção por um falso positivo — rodar em
shadow primeiro, observando decisões reais sem agir sobre elas, é como se constrói essa confiança antes de
ativar `enforce`.
