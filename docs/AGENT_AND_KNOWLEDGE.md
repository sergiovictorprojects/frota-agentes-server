# Catálogo de Agentes, Skills e Conhecimento

## Regra principal

Mais de 200 agentes não significa mais de 200 processos ligados continuamente. O catálogo descreve capacidades; o orquestrador ativa somente o que for necessário, dentro de limites controlados.

## Catálogo de agentes

### Estrutura proposta

| Campo | Finalidade |
|---|---|
| id | Identidade estável do agente |
| slug | Nome técnico único, por exemplo frota:auditoria |
| name | Nome de exibição |
| role | Papel principal |
| status | active, idle, on_demand, suspended ou retired |
| coordinator_id | Responsável por revisão |
| risk_tier | Baixo, médio, alto ou crítico |
| max_concurrency | Limite simultâneo |
| model_config | Modelo e limites permitidos |
| tool_permissions | Ferramentas autorizadas |
| version | Versão da definição do agente |

### Tabelas iniciais

~~~sql
create table agents (
  id uuid primary key,
  slug text not null unique,
  name text not null,
  role text not null,
  status text not null,
  risk_tier text not null,
  max_concurrency integer not null default 1,
  coordinator_agent_id uuid,
  runtime_config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table agent_capabilities (
  agent_id uuid not null references agents(id),
  capability text not null,
  primary key (agent_id, capability)
);
~~~

O código atual de setores deve continuar operando por adaptador até a migração ser comprovadamente segura.

## Famílias recomendadas

| Família | Exemplos |
|---|---|
| Governança | policy-governor, ethical-risk-classifier, privacy-officer, human-escalation-manager |
| Operação | queue-dispatcher, workflow-orchestrator, incident-manager, sla-monitor, cost-controller |
| Auditoria | trace-auditor, evidence-checker, regression-evaluator, failure-pattern-hunter |
| Conhecimento | source-librarian, knowledge-curator, citation-verifier, skill-compiler |
| Dados | postgres-architect, sql-analyst, data-quality-auditor, dashboard-agent |
| Engenharia | security-reviewer, test-builder, ci-fixer, release-manager, docs-agent |
| Produto | opendesign-agent, ux-reviewer, accessibility-reviewer, design-system-guardian |

Cada agente novo precisa de justificativa, limite de ação, dono, testes e métrica. Não criar agentes apenas para aumentar o número do catálogo.

## Skills

Uma skill é um pacote versionado de instruções, contratos, referências e critérios de qualidade reutilizáveis.

Ela deve conter:

- identificador;
- versão;
- instruções;
- entradas permitidas;
- saídas esperadas;
- ferramentas autorizadas;
- políticas aplicáveis;
- fontes e licença;
- testes de regressão;
- status de publicação.

Estados sugeridos:

- draft;
- test;
- canary;
- active;
- retired.

## Conhecimento

Conhecimento deve ser armazenado com proveniência e licença. A expressão absorver conhecimento significa recuperar conteúdo relevante e autorizado no momento de uma etapa, não treinar automaticamente o modelo com qualquer arquivo encontrado.

Fluxo:

~~~text
fonte autorizada
→ documento versionado
→ extração e fragmentação
→ indexação
→ recuperação contextual
→ citação e registro no evento
→ uso controlado pelo agente
~~~

## Fontes

Use apenas material:

- de domínio público verificável;
- com licença compatível;
- produzido pela organização;
- adquirido com direito de uso;
- liberado explicitamente pelo titular.

Não usar acervos piratas, cópias não autorizadas ou fontes sem proveniência.

## Qualidade de recuperação

Métricas:

- taxa de citação válida;
- precisão de fonte;
- cobertura do contexto;
- documentos recuperados e realmente usados;
- resposta sem fonte quando fonte era obrigatória;
- conflito entre fontes;
- custo e latência por consulta.

## Segurança do conhecimento

- Classificar documentos por sensibilidade.
- Redigir conteúdo antes de recuperação quando possível.
- Restringir bases por papel, agente e demanda.
- Registrar a versão exata usada.
- Não permitir que documentos alterem permissões, políticas ou instruções de sistema.
- Avaliar conteúdo externo como não confiável.
