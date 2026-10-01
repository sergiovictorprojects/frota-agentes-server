# Taxonomia de Eventos Operacionais

> **Nota de implementação (Fase 1 — Entrega 1):** a primeira implementação real de `agent_events`
> (migration `002_agent_events.sql`, repositório `src/db/eventos.ts`) diverge do rascunho SQL abaixo.
> Ela usa um cursor global `id bigint GENERATED ALWAYS AS IDENTITY` como ordenação oficial de qualquer
> consulta, mais uma sequência informativa por demanda (`sequencia_demanda`), em vez de um único campo
> `sequence`; não há `agent_step_id`/`agent_id`; e os nomes de coluna são em português, para bater com o
> resto do schema. Os detalhes e o porquê de cada decisão estão em
> [`docs/adr/0002-ledger-eventos-operacionais.md`](adr/0002-ledger-eventos-operacionais.md). O SQL abaixo
> continua sendo a referência conceitual da taxonomia (categorias, canais consumidores) — "não aplicar
> este SQL sem comparar com as migrations atuais" continua valendo.

## Objetivo

Eventos operacionais são o registro cronológico e append-only de fatos relevantes da plataforma. Eles alimentam:

- timeline da demanda;
- tela Em Operação;
- SSE;
- dossiê;
- auditoria;
- métricas;
- visualização 3D;
- diagnóstico de falhas.

Eventos não substituem as tabelas de domínio. A demanda, run, etapa, mensagem, relatório e entrega continuam sendo as fontes do seu próprio estado. O evento registra que algo ocorreu.

## Estratégia de migração

Não remova ou substitua imediatamente agent_steps, mensagens, relatorios ou runs.

Na primeira fase:

1. Mantenha as tabelas existentes.
2. Crie agent_events como histórico transversal.
3. Insira eventos ao lado das alterações relevantes.
4. Crie o dossiê como leitura consolidada.
5. Reavalie duplicidades somente após observar o uso real.

## Estrutura recomendada

~~~sql
create table agent_events (
  id uuid primary key,
  demanda_id uuid not null references demandas(id),
  run_id uuid references runs(id),
  agent_step_id uuid references agent_steps(id),
  agent_id uuid,
  event_type text not null,
  sequence bigint not null,
  correlation_id uuid not null,
  causation_id uuid,
  status text,
  risk_level text,
  visibility text not null default 'operational',
  schema_version integer not null default 1,
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (run_id, sequence)
);
~~~

Os nomes e tipos reais devem seguir as conventions já existentes no projeto. Não aplicar este SQL sem comparar com as migrations atuais.

## Regras de conteúdo

Payloads devem guardar dados mínimos e redigidos. Nunca incluir:

- cadeia de raciocínio interna;
- segredos;
- token de acesso;
- conexão de banco;
- conteúdo integral de documentos sensíveis;
- dados pessoais sem justificativa;
- arquivos codificados em base64;
- respostas inteiras de modelos quando um resumo basta.

Quando a etapa gerar material grande, grave:

~~~json
{
  "artifactId": "uuid",
  "uri": "object-storage-reference",
  "sha256": "hash",
  "classification": "confidential",
  "summary": "Resumo operacional do artefato"
}
~~~

## Tipos de evento

| Grupo | Evento | Quando registrar |
|---|---|---|
| Demanda | demand_received | A demanda foi recebida |
| Demanda | demand_validated | A validação terminou |
| Demanda | demand_classified | Prioridade, setor ou SLA definidos |
| Demanda | demand_claimed | Worker reivindicou a demanda |
| Run | run_created | Nova execução iniciada |
| Run | run_resumed | Execução retomada |
| Run | run_completed | Execução concluída |
| Run | run_failed | Execução falhou |
| Run | run_cancelled | Execução cancelada |
| Etapa | step_started | Etapa iniciada |
| Etapa | step_completed | Etapa concluída |
| Etapa | step_failed | Etapa falhou |
| Etapa | step_retry_scheduled | Retry agendado |
| Agente | agent_selected | Agente escolhido |
| Agente | agent_activated | Agente sob demanda ativado |
| Agente | agent_message | Mensagem operacional resumida |
| Conhecimento | skill_loaded | Skill e versão selecionadas |
| Conhecimento | knowledge_retrieved | Fonte ou documento recuperado |
| Ferramenta | tool_action_proposed | Ação externa proposta |
| Ferramenta | tool_action_completed | Ferramenta concluída |
| Política | policy_evaluated | Regra avaliada |
| Política | policy_violation_found | Violação encontrada |
| Política | human_approval_required | Aprovação solicitada |
| Humano | human_response_received | Resposta recebida |
| Humano | human_approval_granted | Aprovação concedida |
| Humano | human_approval_rejected | Aprovação rejeitada |
| Auditoria | audit_started | Auditoria iniciada |
| Auditoria | audit_completed | Auditoria concluída |
| Entrega | delivery_created | Entrega criada |
| Dossiê | dossier_snapshot_created | Snapshot gerado |

**Implementados na Fase 3.1** (nomes reais do ledger, com schema estrito em `METADATA_SCHEMAS`; ver
[`docs/adr/0006-orquestracao-por-tarefas.md`](adr/0006-orquestracao-por-tarefas.md)):

| Evento | Quando | Metadata |
|---|---|---|
| `plano_registrado` | O plano proposto pelo coordenador passou na validação e foi gravado em shadow | `planoId`, `versao`, `modo` (sempre `shadow`), `totalTarefas`, `totalDependencias` |
| `plano_rejeitado` | A validação determinística recusou o plano | `planoId`, `versao`, `motivoRejeicao` (código fechado) |
| `planejamento_falhou` | O planejamento falhou e a demanda seguiu pelo fluxo legado | `codigoErro` |
| `roteamento_validado` | A demanda passou pela validação determinística de resultado esperado, categoria e critérios de aceite | `resultadoEsperado`, `categoria`, `categoriaSugerida`, `decisao`, `motivo` |

`politica_avaliada` ganhou `operacao` opcional, hoje só `planejamento`, presente só nas operações novas. Nenhuma chave de tarefa entra no ledger: ela é texto vindo do modelo.

**Schemas da Fase 3.2a** (execução por tarefas). Os schemas, a coluna `tarefa_id` e as regras já existem e estão
testados; quem emite estes eventos é a entrega 3.2b. Ver
[`docs/adr/0007-execucao-sequencial-e-teto-de-custo.md`](adr/0007-execucao-sequencial-e-teto-de-custo.md).

| Evento | `tarefa_id` | Metadata |
|---|---|---|
| `rota_definida` | proibida | `rota`, `motivoRota` |
| `plano_ativado` | proibida | `planoId`, `versao`, `totalTarefas` |
| `plano_retomado` | proibida | `planoId`, `versao`, `tarefasConcluidas`, `tarefasRestantes` |
| `plano_abandonado` | proibida | `planoId`, `versao`, `motivoAbandono`, `tarefasCanceladas` |
| `plano_concluido` | proibida | `planoId`, `versao`, `entregaId` |
| `fallback_legado` | proibida | `planoId` (ou nulo), `motivoFallback`, `codigoErro` (ou nulo) |
| `agente_selecionado` | obrigatória | `claimId`, `agente`, `versaoAgente`, `capacidade` |
| `tarefa_iniciada` | obrigatória | `claimId`, `tipo`, `tentativa`, `maxTentativas`, `artefatosIntegrais`, `artefatosSoResumo`, `conversaOmitida` |
| `tarefa_concluida` | obrigatória | `claimId`, `tipo`, `tentativa`, `artefatoId`, `bytes`, `totalReferencias`, `referenciasDescartadas`, `duracaoMs` |
| `tarefa_falhou` | obrigatória | `claimId` (nulo em `contexto_excedido`), `tipo`, `tentativa`, `codigoErro`, `definitiva` |
| `tarefa_devolvida` | obrigatória | `claimId`, `codigoErro` (só paradas antes do envio) |
| `tarefa_lease_expirado` | obrigatória | `claimId`, `tentativa`, `enviada`, `destino` |
| `tarefa_resultado_descartado` | obrigatória | `claimId`, `tentativa`, `motivoDescarte` |
| `custo_demanda_excedido` | opcional | `comprometidoUsd`, `reservaUsd`, `limiteUsd`, `operacao` |
| `custo_acima_da_reserva` | opcional | `operacao`, `reservaUsd`, `custoRealUsd` |
| `custo_adicional_autorizado` | proibida | `valorUsd`, `limiteAnteriorUsd`, `limiteNovoUsd` |
| `gasto_retido_reconhecido` | opcional | `valorUsd`, `operacao` |

Regras, conferidas em `registrarEvento` antes de qualquer escrita:

- `tarefa_id` também é opcional em `entrega_criada` e `politica_avaliada` e proibida em todos os outros tipos. O
  gatilho `agent_events_confere_tarefa` exige que a tarefa seja da mesma demanda do evento.
- `tarefa_falhou`: `claimId` nulo, ator `sistema` e `definitiva` verdadeiro exatamente em `contexto_excedido`, que
  acontece antes do claim.
- `politica_avaliada`: `claimId` vem junto com `tarefaId`, e só com ele; `operacao` ganhou `integracao`.
- Dólares são números com até 6 casas, de 0 a 1.000.000.
- Códigos de erro novos: `lease_expirado`, `artefato_invalido`, `custo_demanda_excedido`, `prazo_da_run`,
  `llm_timeout`, `contexto_excedido` e `agente_alterado`. `motivoDevolucao` ganhou `prazo_da_run`, e
  `motivoRejeicao` ganhou `objetivo_invalido`. `plano_registrado` de um plano em execução tem o resumo fixo
  "Plano de tarefas registrado para execução.".
- O metadata nunca leva `lease_token`, chave ou objetivo de tarefa, conteúdo, resumo ou referência de artefato,
  URL, prompt ou texto de erro. `claimId` pode ir: identifica o claim, mas não autoriza nada.

## Ordem e consistência

1. Na implementação real (ver a nota de implementação no topo deste documento), quem cresce
   monotonicamente é o cursor global `id` — nunca uma sequência por run. `sequencia_demanda` cresce por
   demanda, também nunca por run (uma demanda pode ser processada por runs diferentes ao longo do tempo).
2. Eventos da mesma demanda devem ser consultáveis em ordem estável — hoje, por `id` (ver
   `listarEventosDaDemanda`/`listarEventosDaRun` em `src/db/eventos.ts`).
3. Correções devem produzir novo evento, nunca alterar o evento anterior.
4. Uma mudança de estado e o evento correspondente devem ser gravados na mesma transação quando possível;
   na implementação atual isso é uma exceção deliberada, não a regra — ver a advertência de consistência
   em `registrarEvento` (`src/db/eventos.ts`): o ledger é observacional e degradável, dual-write fail-open,
   em transação própria e separada da transação que grava o estado real.
5. Se houver publicação assíncrona para SSE, publique somente após a persistência bem-sucedida.
6. SSE deve suportar cursor de sequência e replay. **Atenção:** `id` (cursor global, `GENERATED ALWAYS AS
   IDENTITY`) é estável para leitura pontual — mesma ordem sempre, para o mesmo conjunto de linhas — mas
   **não é**, por si só, um cursor sem perdas para consumo incremental (`WHERE id > cursor`) sob escritores
   concorrentes: uma transação com `id` menor pode fazer `COMMIT` depois de uma com `id` maior (o valor da
   sequência é reservado antes do commit), e um consumidor que já passou pelo `id` maior nunca voltaria
   para pegar o menor. Isso é seguro para leitura direta da timeline de uma demanda (que já espera
   consistência eventual), mas não é suficiente, sozinho, para um SSE sem perdas na Fase 5 — essa fase vai
   exigir um outbox transacional (uma tabela de outbox gravada na mesma transação do estado real, com um
   publicador que lê e apaga/marca de forma serializada) ou uma publicação serializada por um único
   processo, não a leitura direta de `agent_events` por cursor de `id`.

## Exemplo de payload seguro

~~~json
{
  "agentSlug": "frota:auditoria",
  "stepName": "avaliar-entrega",
  "decisionSummary": "Entrega enviada para auditoria por conter publicação externa.",
  "inputReferences": ["artifact:ab12"],
  "outputReferences": ["report:cd34"],
  "policyRuleIds": ["external-publication-approval"],
  "skillVersion": "auditoria-1.2.0",
  "durationMs": 2140,
  "tokenUsage": {
    "input": 981,
    "output": 402
  }
}
~~~

## Índices iniciais

Os índices devem ser confirmados com volume e plano de consulta reais. O ponto de partida provável é:

- demanda_id e occurred_at;
- run_id e sequence;
- agent_id e occurred_at;
- event_type e occurred_at;
- correlation_id.

Quando o volume exigir, avaliar particionamento mensal de eventos e retenção por classificação.