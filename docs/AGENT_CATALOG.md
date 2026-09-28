# Catálogo de Agentes

## Status desta entrega (Fase 2 — Entrega 1)

Implementado: as tabelas `agentes` e `agentes_historico` (migration `003_agentes.sql`), o repositório
tipado (`src/db/agentes.ts`), o seed idempotente a partir de `SETORES` (`src/domain/setores.ts`) e duas
validações no orquestrador — para a execução e para a auditoria — checando que o agente solicitado existe,
está `ativo` **e** que o modelo da chamada bate com `modelo_permitido`, antes de qualquer chamada ao
modelo. `id`, `chave`, `nome`, `descricao`, `categoria` e `papel` são imutáveis — não há UPDATE sancionado
para eles nesta entrega. `estado`, `modelo_permitido` e `politica_ref` podem mudar, e a garantia real é do
banco: o gatilho `agentes_controlar_mudancas` grava `agentes_historico` e incrementa `versao` como parte
do próprio `UPDATE`, para **qualquer** `UPDATE` que chegue à tabela — inclusive um SQL direto que nunca
chamou `atualizarAgente()`. Não é uma permissão que se pode burlar: é um efeito colateral automático do
UPDATE em si (ver "Identidade imutável e trilha obrigatória" abaixo — corrigido depois de uma primeira
versão que usava uma flag de sessão facilmente contornável).

**Não implementado nesta entrega** (alvo futuro, fora de escopo aqui):
- skills versionadas e conhecimento (`docs/AGENT_AND_KNOWLEDGE.md`, Fase 4);
- SSE/tempo real (Fase 5);
- cidade 3D (Fase 7);
- Policy Engine (`docs/POLICY_AND_SECURITY.md`) — `politica_ref` existe como coluna, mas fica `NULL` até
  o Policy Engine existir (ver ADR 0003);
- acionamento explícito de agentes `sob_demanda` (a coluna e o estado existem; nada os aciona ainda);
- edição de `nome`/`descricao`/`categoria`/`papel` — são imutáveis nesta entrega (sem rota de
  administração, não haveria como auditar essa mudança, então o banco simplesmente a bloqueia);
- qualquer rota HTTP de administração do catálogo — o caminho recomendado é chamar `atualizarAgente()`
  (por script/console; não há rota HTTP ainda), mas mesmo sem ele um `UPDATE` direto em `estado`,
  `modelo_permitido` ou `politica_ref` funciona e gera trilha automaticamente (ver abaixo);
- migração de `demandas.categoria` para referenciar `agentes.id` — `demandas` continua usando `Categoria`
  (`src/domain/setores.ts`) exatamente como antes; o catálogo só valida, não substitui, a categoria.

## Por que existe

A estrutura atual de setores (`gestores`, `d1`..`d18`) é uma constante TypeScript fixa — útil, mas sem
histórico, sem estado operacional (ativo/suspenso) e sem identidade própria no banco. O catálogo persiste
essa mesma informação de forma consultável e auditável, primeiro passo para o Policy Engine (Fase 2
seguinte) e para o catálogo real de agentes com skills e conhecimento versionados (Fase 4). Ver
`docs/adr/0003-catalogo-de-agentes.md` para o raciocínio completo por trás da ordem das fases.

## Modelo de dados

Tabela `agentes` (migration `003_agentes.sql`):

| Coluna | Tipo | Notas |
|---|---|---|
| `id` | `uuid` | Chave primária, gerada. Imutável — nunca muda, sob nenhuma circunstância (gatilho `agentes_controlar_mudancas`). |
| `chave` | `text`, único | Identidade estável. Hoje é literalmente `Setor.papel` (ex.: `"frota:architect"`) — a mesma string já usada em `mensagens.agente`, `relatorios.gerente` e em `agent_events`. Imutável. |
| `nome` | `text` | Nome de exibição (ex.: `"Arquitetura & Sistema"`). Imutável nesta entrega — sem rota de administração, não há UPDATE sancionado para ele. |
| `descricao` | `text`, até 500 caracteres | Curta e controlada pelo código de seed — nunca texto gerado por modelo. Imutável, mesmo motivo que `nome`. |
| `categoria` | `text` | Um dos 19 valores de `Categoria` (`gestores`, `d1`..`d18`). Imutável. |
| `papel` | `text` | `coordenador`, `executor`, `avaliador` ou `auditor`. Imutável. |
| `estado` | `text`, padrão `'ativo'` | `ativo`, `suspenso` ou `sob_demanda`. Editável — toda mudança gera trilha automaticamente (ver abaixo). |
| `versao` | `integer`, padrão `1` | O gatilho sempre soma 1 ao valor já gravado quando `estado`/`modelo_permitido`/`politica_ref` muda de fato — nunca aceita um valor vindo de fora, nunca muda sem uma linha correspondente em `agentes_historico`. |
| `modelo_permitido` | `text`, formato livre | Qual modelo este agente pode usar — checado de verdade em `agenteEstaAutorizado` (ver abaixo). O seed usa `MODEL_WORK` para coordenador/executores e `MODEL_AUDIT` para o auditor (d17). Editável, com trilha. |
| `politica_ref` | `text`, nulo, formato de slug (`^[a-z0-9][a-z0-9_-]{0,63}$`) | Referência curta e fechada a uma regra de política — sempre `NULL` até o Policy Engine existir. O formato fechado impede colar uma frase, um prompt ou um segredo aqui; imposto por `CHECK` na migration e por Zod em `atualizarAgente()`. Editável, com trilha. |
| `criado_em` / `atualizado_em` | `timestamptz` | `atualizado_em` só muda junto com uma mudança real de `estado`/`modelo_permitido`/`politica_ref` — o gatilho ignora um `UPDATE` que só tentasse tocá-lo sozinho. |

Nenhuma coluna guarda prompt, token, segredo ou texto livre de execução — testado explicitamente em
`test/db/agentes.test.ts`.

### Por que "agent-evaluator" não é uma linha própria

`PAPEL_AUDITOR` em `src/orchestrator/processar-demanda.ts` é literalmente `SETORES.d17.papel`
(`"frota:agent-evaluator"`), usado em toda chamada de auditoria — não só quando a demanda é da categoria
`d17`. O seed cobre isso naturalmente: a linha de `d17` já tem `chave = "frota:agent-evaluator"` e
`papel = "auditor"`. Criar uma segunda linha duplicaria a mesma identidade sob um nome diferente.

## Seed

`seedAgentesPadrao(pool, modeloTrabalho, modeloAuditoria)` (`src/db/agentes.ts`) insere os 19 agentes —
`gestores` + `d1`..`d18` — a partir de `SETORES`, um por categoria, com `INSERT ... ON CONFLICT (chave) DO
NOTHING`. O auditor (`d17`, `papel = 'auditor'`) nasce com `modelo_permitido = modeloAuditoria`; todo o
resto (coordenador e executores) nasce com `modelo_permitido = modeloTrabalho` — o mesmo modelo que cada
papel de fato chama em `processar-demanda.ts` (`d.modeloAuditoria`/`d.modeloTrabalho`).

- **Idempotente**: rodar de novo nunca duplica nem sobrescreve um `estado`/`nome`/`descricao`/`modelo_permitido`
  já ajustado manualmente — só insere linhas que ainda não existem.
- **Roda automaticamente no boot** (`src/main.ts`, logo após `migrate(pool)`, com `config.MODEL_WORK` e
  `config.MODEL_AUDIT`), do mesmo jeito que as migrations — não é um script manual separado.
- **Roda automaticamente nos testes** (`test/helpers/db.ts`, dentro de `createTestDb()`), para que a nova
  validação de autorização do orquestrador tenha um catálogo para consultar em todo teste existente, sem
  mudar o comportamento de nenhum deles.

## Repositório (`src/db/agentes.ts`)

| Função | Uso |
|---|---|
| `obterAgentePorChave(pool, chave)` | Busca um agente por sua identidade estável. `null` se não existir. |
| `listarAgentesAtivos(pool)` | Só `estado = 'ativo'`. |
| `listarAgentesSobDemanda(pool)` | Só `estado = 'sob_demanda'`. |
| `agenteEstaAutorizado(pool, chave, modelo)` | `true` só quando o agente existe, está `ativo` **e** `modelo` bate exatamente com `modelo_permitido`. `sob_demanda` não conta — exige acionamento explícito, que esta entrega não implementa. Um agente inexistente, ou com o modelo errado, também não está autorizado. |
| `atualizarAgente(pool, chave, ator, mudancas)` | Jeito recomendado de mudar `estado`/`modeloPermitido`/`politicaRef` — valida o formato de `ator` e `politicaRef` antes de ir ao banco, e identifica quem fez a mudança (para a trilha) via `set_config`. A garantia de trilha em si **não depende desta função**: vem do gatilho (ver abaixo). Sem mudança real (nada difere do valor atual): não faz nada, não versiona, não registra. |
| `listarHistoricoDoAgente(pool, agenteId)` | Trilha completa de um agente, ordenada por `id` (cursor estável). |
| `seedAgentesPadrao(pool, modeloTrabalho, modeloAuditoria)` | Seed idempotente, descrito acima. |

Toda leitura passa por um schema Zod (`AgenteSchema`/`AgenteHistoricoSchema`) antes de ser devolvida —
validação runtime, não confia cegamente no shape que o driver do Postgres devolve.

### Identidade imutável e trilha obrigatória de auditoria

Um único gatilho, `agentes_controlar_mudancas` (migration `003_agentes.sql`, função `agentes_controlar_mudancas()`),
faz todo o trabalho, para **qualquer** `UPDATE` que chegue à tabela `agentes` — não importa se veio de
`atualizarAgente()`, de um script, de um console `psql`, ou de qualquer outra query com as mesmas
credenciais da aplicação:

1. **Bloqueia sempre** qualquer `UPDATE` que mude `id`, `chave`, `nome`, `descricao`, `categoria` ou
   `papel` — campos imutáveis nesta entrega, sem exceção.
2. Para `estado`, `modelo_permitido` e `politica_ref`: se nenhum dos três mudou de fato, o gatilho ignora
   silenciosamente qualquer tentativa de mexer em `versao` ou `atualizado_em` sozinhos (um `UPDATE agentes
   SET versao = 999` não tem efeito nenhum). Se pelo menos um dos três mudou de fato, o gatilho:
   - calcula `versao_nova = versao_atual + 1` **ele mesmo** — nunca aceita um valor de `versao` vindo do
     `UPDATE`, então não dá para pular, repetir ou escolher um número;
   - atualiza `atualizado_em`;
   - insere uma linha em `agentes_historico` com o que mudou, **como parte do mesmo `UPDATE`** — não uma
     chamada separada que poderia falhar ou ser pulada.

> **Correção em relação a uma versão anterior desta entrega:** a primeira implementação tentava impedir
> `UPDATE` direto de `estado`/`modelo_permitido`/`politica_ref` com uma flag de sessão
> (`SET LOCAL frota.atualizacao_agente_autorizada = 'on'`) que só `atualizarAgente()` ligava. Isso era
> **teatro de segurança**: qualquer sessão conectada com a mesma `DATABASE_URL` da aplicação podia rodar a
> mesma `SET LOCAL` e escrever direto, sem trilha nenhuma — a "permissão" não protegia nada contra alguém
> com as mesmas credenciais do runtime, que é exatamente quem executa código da aplicação. **Isso foi
> removido.** Não existe mais uma permissão a burlar: `UPDATE` direto de `estado`/`modelo_permitido`/
> `politica_ref` **funciona** — a garantia não é "impedir o UPDATE", é "nenhum UPDATE escapa da trilha",
> porque a trilha é gravada pelo próprio gatilho, dentro da mesma operação, sempre. O único grau de
> liberdade que sobra é o rótulo `ator`: um `UPDATE` que nunca chamou `set_config('frota.ator_da_alteracao',
> ..., true)` ainda assim grava a trilha — só que atribuída ao valor sentinela `'sistema:sql_direto'`, que
> deixa evidente, na própria trilha, que aquela mudança não passou pelo caminho recomendado. Ver
> `test/db/agentes.test.ts` para os testes que tentam burlar isso (inclusive imitando `atualizarAgente()`
> "por fora", com `set_config` manual) e confirmam que a trilha é sempre gravada.

A tabela `agentes_historico` é append-only (mesmo padrão de `agent_events`, migration `002`): um gatilho
separado bloqueia `UPDATE`/`DELETE` diretos nela. Cada linha registra `agente_id`, `ator` (formato fechado
de identificador — `^[a-z0-9][a-z0-9_.:-]{0,99}$`, imposto por `CHECK` e por Zod, nunca uma frase livre),
`campos_alterados` (jsonb com só os campos que de fato mudaram — nunca texto livre: `estado` e
`modelo_permitido` são valores curtos e controlados, `politica_ref` é uma referência de formato fechado,
não conteúdo), `versao_anterior` e `versao_nova`.

## Mudança no orquestrador

`processarDemanda` (`src/orchestrator/processar-demanda.ts`) valida **dois** agentes, cada um antes da
chamada ao modelo correspondente:

- **Execução**: `agenteEstaAutorizado(pool, setor.papel, d.modeloTrabalho)`, dentro do `try/catch` que já
  tratava falhas da chamada ao modelo de execução. Se não autorizado, lança `AgenteNaoAutorizadoError`
  (`src/orchestrator/erros.ts`) antes de qualquer chamada ao modelo.
- **Auditoria**: `agenteEstaAutorizado(pool, PAPEL_AUDITOR, d.modeloAuditoria)`, no início de `auditar()`,
  antes do laço de tentativas. Se não autorizado, nenhuma chamada ao modelo de auditoria acontece — emite
  só `auditoria_interrompida` com `codigoErro: 'agente_nao_autorizado'` e retorna métricas nulas, **sem**
  interromper a run (não é parada sistêmica): a demanda ainda conclui, do mesmo jeito que quando a
  auditoria esgota as tentativas por erro comum.

Em ambos os casos, a falha:

- é classificada como o código `agente_nao_autorizado` no ledger (`agent_events`), nunca como texto livre;
- **não** é tratada como parada sistêmica — não interrompe a run inteira, só a chamada em questão.

Nenhum prompt foi alterado, nenhuma lógica de fila (`processar-fila.ts`) foi tocada, nenhum agente é
criado dinamicamente. Como todo agente nasce `ativo` pelo seed, com o modelo que de fato usa, essas
checagens são hoje um no-op para qualquer demanda das 19 categorias existentes — só passam a barrar de
verdade quando um operador suspender um agente, ou mudar seu `modelo_permitido`, via `atualizarAgente()`.
