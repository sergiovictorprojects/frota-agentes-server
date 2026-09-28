# Taxonomia de Eventos Operacionais

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

## Ordem e consistência

1. Sequence deve aumentar por run.
2. Eventos do mesmo run devem ser consultáveis em ordem estável.
3. Correções devem produzir novo evento, nunca alterar o evento anterior.
4. Uma mudança de estado e o evento correspondente devem ser gravados na mesma transação quando possível.
5. Se houver publicação assíncrona para SSE, publique somente após a persistência bem-sucedida.
6. SSE deve suportar cursor de sequência e replay.

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
