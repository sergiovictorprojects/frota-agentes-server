# ADR 0003 — Catálogo de agentes antecede o Policy Engine

## Status

Implementada na Fase 2 — Entrega 1.

## Contexto

`docs/IMPLEMENTATION_ROADMAP.md` lista, em ordem: Fase 1 (Modelo Operacional Auditável — o ledger
`agent_events`, já implementado nas Entregas 1 e 2), Fase 2 (Policy Engine em modo shadow), Fase 3
(catálogo real de agentes), Fase 4 (skills e conhecimento). Este ADR documenta uma decisão deliberada de
**inverter a ordem entre Policy Engine e catálogo de agentes**: implementar primeiro um catálogo mínimo de
agentes (Fase 2 — Entrega 1, este ADR) e só depois o Policy Engine em si.

## Decisão

Implementar o catálogo de agentes (`agentes`, migration `003_agentes.sql`) antes de qualquer código de
Policy Engine.

## Por quê

Um Policy Engine avalia regras **sobre** algo — uma ação, um agente, um recurso. `docs/POLICY_AND_SECURITY.md`
já define os estágios (`pre`/`during`/`post`) e as decisões (`allow`/`warn`/`require_approval`/`deny`), mas
toda regra precisa de um sujeito estável para se aplicar: "o agente X pode fazer a ação Y" pressupõe que
"o agente X" seja uma entidade identificável, consultável e com estado (ativo/suspenso), não apenas uma
string solta espalhada por `mensagens.agente`, `relatorios.gerente` e nos prompts do orquestrador.

Sem um catálogo:
- uma `policy_rules.condition` que precisasse referenciar "todo agente de categoria d4" ou "o agente cujo
  estado é X" não teria onde consultar isso;
- `politica_ref` (a coluna já reservada em `agentes`, ver `docs/AGENT_CATALOG.md`) não existiria como algo
  para uma política apontar de volta;
- o próprio ato de "suspender um agente" — a forma mais básica e determinística de bloqueio, mais simples
  que qualquer regra condicional — não teria uma linha para marcar como suspensa.

Construir o catálogo primeiro, mesmo mínimo (sem skills, sem versionamento de verdade, sem UI de
administração), dá ao Policy Engine um sujeito real para avaliar desde o primeiro dia, em vez de o Policy
Engine nascer avaliando uma entidade fictícia que precisaria ser retrabalhada assim que o catálogo
chegasse.

## Escopo desta entrega — o que NÃO foi implementado

Deliberadamente fora, para manter esta entrega mínima e reversível:

- **Skills e conhecimento versionados** (`docs/AGENT_AND_KNOWLEDGE.md`, Fase 4 do roadmap) — o catálogo
  desta entrega não tem `skill_versions`, `agent_skills` nem `knowledge_sources`. Um agente aqui é só
  identidade + estado + categoria + papel, nada de capacidades declaradas.
- **SSE/tempo real** (Fase 5) — nenhuma mudança em como o estado do catálogo seria transmitido ao vivo;
  não existe consumidor de eventos de catálogo.
- **Cidade 3D** (Fase 7) — nenhuma projeção visual do catálogo.
- **Policy Engine em si** (`policy_rules`, `policy_evaluations`) — a coluna `politica_ref` existe e fica
  `NULL` em todo agente seedado; nada a preenche ou avalia ainda.
- **Acionamento explícito de agentes `sob_demanda`** — o estado existe no domínio (`ESTADOS_AGENTE`) e a
  consulta (`listarAgentesSobDemanda`) existe, mas nenhum código aciona um agente `sob_demanda`; hoje eles
  simplesmente não são autorizados a trabalhar (`agenteEstaAutorizado` só considera `ativo`).
- **Rota HTTP de administração do catálogo** — suspender, reativar ou mudar `estado`/`modelo_permitido`/
  `politica_ref` de um agente hoje é feito chamando `atualizarAgente()` (por script ou console) ou por
  `UPDATE` direto — os dois caminhos funcionam e os dois geram trilha em `agentes_historico`
  automaticamente, porque a garantia está no gatilho do banco, não numa rota específica (ver abaixo).

## Mudança no orquestrador

`processarDemanda` (`src/orchestrator/processar-demanda.ts`) valida dois agentes, cada um antes da chamada
ao modelo correspondente: `agenteEstaAutorizado(pool, setor.papel, d.modeloTrabalho)` para a execução, e
`agenteEstaAutorizado(pool, PAPEL_AUDITOR, d.modeloAuditoria)` no início de `auditar()`, antes do laço de
tentativas — sem alterar prompts, a lógica de fila (`processar-fila.ts`), ou criar agentes dinamicamente.
Como o seed sempre cria agentes `ativo` com o modelo que cada papel de fato chama, estas validações são
hoje um no-op para o comportamento observável de qualquer demanda: começam a ter efeito real só quando um
operador suspender um agente, ou mudar seu `modelo_permitido`, via `atualizarAgente()`. Ver
`docs/AGENT_CATALOG.md` para o detalhe completo.

## Identidade imutável e trilha obrigatória de auditoria

`id`, `chave`, `nome`, `descricao`, `categoria` e `papel` são absolutamente imutáveis — o gatilho
`agentes_controlar_mudancas` (migration `003_agentes.sql`) bloqueia qualquer `UPDATE` que os altere, sem
exceção. Sem rota de administração nesta entrega, não haveria como auditar uma mudança neles, então o
banco simplesmente não permite que mudem.

`estado`, `modelo_permitido` e `politica_ref` **podem** mudar, e a garantia de trilha não é uma permissão
— é um efeito automático do próprio `UPDATE`. Uma primeira versão desta entrega tentava impedir `UPDATE`
direto desses três campos com uma flag de sessão (`SET LOCAL frota.atualizacao_agente_autorizada = 'on'`)
que só `atualizarAgente()` ligava. **Isso era teatro de segurança**: qualquer sessão com a mesma
`DATABASE_URL` da aplicação — exatamente a mesma credencial que o runtime usa — podia rodar a mesma `SET
LOCAL` e escrever direto, sem trilha. A permissão não protegia contra ninguém que já tivesse acesso de
runtime, que é precisamente quem executa o código da aplicação.

A correção: `agentes_controlar_mudancas` grava `agentes_historico` e calcula `versao_nova = versao_atual +
1` **ele mesmo**, como parte do próprio `UPDATE` — não como uma segunda escrita que uma função de
aplicação decide fazer ou não. Isso vale para qualquer caminho que chegue à tabela: `atualizarAgente()`,
SQL direto, um script futuro. Não há permissão a burlar porque não há portão — o único grau de liberdade
que sobra é o rótulo `ator` na trilha (via `set_config('frota.ator_da_alteracao', ..., true)`,
transaction-local): um `UPDATE` que nunca o chamou ainda assim grava a trilha, atribuída ao sentinela
`'sistema:sql_direto'`, que evidencia — na própria trilha — que aquela mudança não passou pelo caminho
recomendado. `ator` e `politica_ref` também ganharam formato fechado (identificador curto / slug), via
`CHECK` na migration e Zod em `atualizarAgente()`: nenhum dos dois aceita texto livre, prompt ou frase.

`agentes_historico` é append-only, com o mesmo gatilho de bloqueio de `UPDATE`/`DELETE` já usado em
`agent_events` (migration `002`).

## Consequências

- Quando o Policy Engine (próxima entrega da Fase 2) for implementado, ele já tem `agentes.chave`/`id`
  como sujeito estável para suas regras e `agentes.politica_ref` como o lugar óbvio para apontar a
  política ativa de um agente, sem precisar de uma migration adicional só para isso — e já pode gravar
  essa mudança de política via `atualizarAgente()`, com trilha, em vez de precisar inventar seu próprio
  mecanismo de auditoria.
- `demandas.categoria` continua sendo a fonte de verdade sobre qual setor processa uma demanda — o
  catálogo valida ("este agente pode trabalhar, com este modelo?"), não substitui, a seleção de setor.
- Uma futura rota HTTP de administração do catálogo só precisa chamar `atualizarAgente()` — a trilha, a
  imutabilidade de identidade e o versionamento já estão garantidos no banco, não algo que essa rota
  precisaria reimplementar.

## Reversibilidade

Migration aditiva; nenhuma tabela existente foi alterada. Reverter significa parar de chamar
`seedAgentesPadrao` no boot, remover as duas checagens em `processarDemanda` (que hoje nunca bloqueiam
nada em operação normal) e, se necessário, dropar as tabelas `agentes` e `agentes_historico` — sem impacto
em `demandas`, `agent_events` ou qualquer outra tabela de domínio.
