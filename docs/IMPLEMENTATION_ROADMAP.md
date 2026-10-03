# Roadmap de Implementação

## Regra de execução

Implementar por fatias verticais, com migrations aditivas, testes e rollback. Não iniciar cidade 3D, centenas de agentes ou aprendizado autônomo antes de haver uma trilha operacional confiável.

## Situação atual (2026-09-29)

| Fase | Situação |
|---|---|
| 0 — Diagnóstico e baseline | Concluída |
| 1 — Modelo Operacional Auditável | Concluída: ledger `agent_events` (002), dossiê ao vivo e CI |
| 2 — Catálogo e Policy Engine shadow | Concluída: catálogo e histórico de agentes (003); Policy Engine shadow (004) |
| Hotfix — URL de entrega segura | Concluído (ADR 0005) |
| **3 — Orquestração Real por Tarefas** | Em andamento: 3.1, 3.2a, 3.2b-1 e 3.2b-2 implementadas; piloto controlado em staging em validação. 3.2c, 3.3 e 3.4 planejadas |
| 4 a 9 | Sem mudança |

Continuam pendentes, sem data: estados `idle` e `retired` no catálogo e o snapshot versionado do dossiê
(`dossier_snapshots`). As capacidades de arquivos finais estão persistidas e auditadas no catálogo desde a
migration 007; uma superfície administrativa para editá-las continua futura.

## Fase 0 — Diagnóstico e baseline

### Objetivo

Confirmar a arquitetura real antes de alterar comportamento.

### Ações

1. Executar git status.
2. Ler README, package.json, migrations, orquestradores, HTTP, domínio e testes.
3. Documentar estados reais de demanda, tabela de dados e fluxo de execução.
4. Rodar typecheck e testes existentes.
5. Identificar gaps entre esta documentação e o repositório.
6. Criar ou revisar ADRs necessários.

### Critério de aceite

Relatório técnico com arquivos relevantes, comandos, riscos, divergências, plano de migração e estratégia de rollback. Nenhuma alteração estrutural ainda.

## Fase 1 — Modelo Operacional Auditável

### Objetivo

Transformar uma demanda já processada pelo sistema em uma operação rastreável e consultável.

### Escopo

- Criar agent_events ou adaptar estrutura equivalente.
- Criar serviço de gravação de eventos.
- Instrumentar o fluxo existente de fila e processamento.
- Registrar eventos de estados, etapas, erro, auditoria e entrega.
- Criar endpoint inicial do dossiê.
- Criar snapshots finais do dossiê.
- Adicionar testes de eventos, ordenação e dossiê.

### Não fazer

- Não substituir setores por catálogo novo ainda.
- Não ativar bloqueio por Policy Engine.
- Não criar interface 3D.
- Não incluir streaming em tempo real ainda.

### Critério de aceite

Uma demanda real ou de teste percorre:

~~~text
criação
→ fila
→ run
→ etapas
→ auditoria
→ entrega
→ dossiê final
~~~

O dossiê deve refletir eventos reais e não dados simulados.

## Fase 2 — Policy Engine em modo shadow

### Objetivo

Aplicar regras sem bloquear produção.

### Escopo

- Criar policy_rules e policy_evaluations.
- Definir regras iniciais de alto valor.
- Avaliar pré-execução, uso de ferramenta e pós-execução.
- Registrar allow, warn, require_approval e deny.
- Exibir resultados no dossiê.
- Criar testes de regras e casos de borda.

### Regras iniciais recomendadas

- ação externa sem aprovação;
- ação destrutiva;
- acesso a dado classificado;
- uso de fonte sem proveniência;
- custo acima de limite;
- publicação sem revisão;
- tentativa de usar segredo em prompt ou ferramenta.

### Critério de aceite

As avaliações aparecem no dossiê e nos eventos, sem alterar ainda a continuidade do workflow.

## Fase 3 — Orquestração Real por Tarefas

Substitui a antiga "Catálogo real de agentes": o catálogo e o histórico já existem (migration 003), e o que
restava dela (seleção por capacidade e disponibilidade, limite de concorrência e eventos de seleção) entra
aqui. Decisões e rollback em `docs/adr/0006-orquestracao-por-tarefas.md`.

### Objetivo

Trocar a execução de uma demanda por uma única chamada por um plano de tarefas especialistas com
dependências e uma tarefa de integração que produz a entrega única, sem quebrar o fluxo atual.

### Princípios

- Nenhuma transação aberta durante chamada ao modelo: claim curto com lease e token, chamada fora da
  transação e persistência condicional ao lease.
- Chamada ao modelo é at-least-once; estado, artefato e entrega final são idempotentes.
- A flag `ORQUESTRACAO_TAREFAS` controla tudo, e `desligada` devolve o fluxo legado inteiro.

### Entregas

- **3.1 — Somente `planejar` (implementada).** O coordenador propõe o plano, a validação é determinística e o
  plano é gravado em shadow. A demanda segue pelo fluxo legado. Migration 005, restrita ao shadow
  (`planos_demanda`, `tarefas` e `tarefas_dependencias` imutáveis, ciclos barrados no banco, `operacao`
  ampliada só com `planejamento`).
  - **3.2 — Execução sequencial**, em duas PRs (plano versão 4, decisão 6A):
  - **3.2a — Base, sem ligar nada (em PR draft).** Migration 006 com o envelope da demanda, os estados e a máquina
    de estados de planos e tarefas, o grafo congelado depois da ativação, `artefatos_tarefa`, `reservas_custo`,
    `autorizacoes_custo`, as colunas novas de `agent_steps`, `tarefa_id` e `claim_id` nos eventos e nas
    avaliações e `operacao: integracao`. Repositórios tipados, serialização canônica com limites de contexto,
    tabela de modelos com janela e custo em decimal. A proteção de ciclo no banco continua. Ver
    `docs/adr/0007-execucao-sequencial-e-teto-de-custo.md`.
  - **3.2b-1 — Motor sequencial inerte (implementada).** Laço interno de tarefas, prompts serializados, prazo,
    timeouts, claims, leases, liquidação por reserva, artefatos intermediários e integração final.
  - **3.2b-2 — Ativação controlada (implementada; piloto em staging).** Flag `executar`, uma categoria ligada por vez
    e teto base explícito por demanda. O piloto permanece pausável e limitado a uma demanda até validar uma entrega
    real de ponta a ponta.
  - **3.2c-0 — Robustez LLM e degradação inteligente (em implementação).** Endurece o piloto antes de expandir
    roteamento: falhas `llm_api`/`llm_timeout` em tarefas continuam registradas como falhas sistêmicas enquanto há
    tentativa disponível, mas quando a tarefa esgota o plano por tarefas fixa `legado_fixo` com motivo auditável e
    permite seguir pela rota legada. No fluxo legado, `llm_api`/`llm_timeout` também são retomáveis: a demanda volta
    para `Nova`, a tentativa é desfeita e o ledger recebe `retentativa_sistemica_agendada`, em vez de marcar a demanda
    como `Falhou` por instabilidade do provedor. Para não girar para sempre, três retentativas sistêmicas de LLM na
    mesma demanda em 60 minutos pausam o retry automático e levam a demanda para `Aguardando humano` com
    `bloqueio_humano.tipo = falha_sistemica_llm_recorrente`. Mantém a retomada de plano ativo sem criar plano duplicado.
  - **3.2c — Validação em camadas e roteamento de demanda (em implementação).** Evita que
    a categoria escolhida no formulário, hoje padronizada como `gestores`, contradiga o resultado solicitado.
    1. O formulário passa a registrar explicitamente o resultado esperado (`interface`, `documento`, `análise`,
       `automação`, `código` ou outro formato aprovado) e critérios de aceite observáveis.
       Também passa a registrar complexidade operacional e uma estimativa determinística de chamadas LLM,
       tokens, custo previsto e orçamento sugerido por demanda, exibida ao solicitante antes e depois da criação.
    2. Regras determinísticas validam a compatibilidade entre resultado esperado, categoria, capacidades do agente,
       permissões de publicação e custo. Combinações incompatíveis são bloqueadas ou exigem confirmação explícita.
    3. Um recomendador pode sugerir categoria e papéis, mas não pode autorizar a execução: catálogo, políticas e
       regras determinísticas continuam sendo a fonte de decisão.
    4. Casos ambíguos ou de baixa confiança ficam em `Aguardando humano`; não há troca silenciosa de categoria.
    5. A conclusão exige uma entrega compatível com os critérios registrados. Um resumo textual não conclui uma
       demanda cujo resultado esperado seja uma interface ou artefato baixável.
    6. A decisão, a recomendação, a confirmação humana e o motivo do fallback são registrados em eventos e no
       dossiê, sem armazenar prompt ou raciocínio interno.

    **Não fazer nesta fatia:** classificador puramente por LLM, roteamento autônomo para múltiplos agentes sem
    confirmação, alteração retroativa da categoria de demandas existentes ou publicação de HTML sem isolamento.

    **Critério de aceite:** uma demanda de interface criada inicialmente em `gestores` fica em `Aguardando humano`
    com decisão auditável; uma demanda em `d11` só conclui com entrega HTML/artefato compatível; uma demanda de análise
    continua aceitando texto; todas as decisões são reproduzíveis por regras e cobertas por testes unitários,
    integração e workflow.
- **3.3 — Concorrência.** `agentes.max_concorrencia` com gatilho, histórico, Zod e testes; lock da linha do
  agente no claim; paralelismo de 2; estado `aguardando_agente`, que não consome tentativa e escala para
  humano no prazo.
- **3.4 — Dossiê.** Seções Participantes e Etapas, só com metadados de tarefas e artefatos.

### Não fazer

- Não executar tarefas antes da 3.2b, nem paralelizar antes da 3.3.
- Não criar fila pg-boss por tarefa, SSE, cidade 3D ou Policy Engine em enforce nesta fase.

### Critério de aceite

Uma demanda de uma categoria ligada percorre plano, tarefas, integração e entrega única, com eventos e
avaliações por tarefa. Com a flag desligada, o fluxo é idêntico ao legado.

## Fase 4 — Skills e conhecimento versionados

### Objetivo

Permitir conhecimento especializado rastreável.

### Escopo

- Criar skill_versions, agent_skills, knowledge_sources e metadados de documentos.
- Definir processo de aprovação e versionamento.
- Implementar recuperação contextual limitada.
- Registrar fontes, licenças e versões no dossiê.

### Critério de aceite

Uma etapa pode usar uma skill e uma fonte autorizada, com versão e evidência consultáveis.

## Fase 5 — Tempo real e interface operacional

### Objetivo

Exibir o workflow usando eventos persistidos.

### Escopo

- Criar endpoint SSE com cursor e replay.
- Criar endpoint de estado operacional.
- Criar timeline de demanda.
- Exibir agentes, etapas, alertas, custos e revisões.
- Aplicar controle de acesso a cada stream e tela.

### Critério de aceite

Desconexão e reconexão não perdem eventos. Usuários não autorizados não conseguem receber eventos de outra demanda.

## Fase 6 — Regras em modo enforce

### Objetivo

Ativar bloqueios apenas para regras comprovadas.

### Escopo

- Revisar métricas do modo shadow.
- Habilitar bloqueio gradual para regras críticas.
- Criar fluxos de aprovação humana.
- Implementar rollback de regra.

### Critério de aceite

Uma ação proibida é bloqueada, documentada e pode ser tratada por fluxo humano autorizado.

## Fase 7 — Visualização 3D

### Objetivo

Construir uma representação visual útil da operação, não uma simulação decorativa.

### Escopo

- Criar projeção de grafo derivada de eventos.
- Definir distrito, setor, agente, conexão, risco e status.
- Implementar filtros por demanda, agente, setor e período.
- Garantir acessibilidade e modo simplificado em 2D.
- Validar desempenho com grandes volumes de eventos.

### Critério de aceite

Todo elemento visual pode ser relacionado a dados reais, e a mesma demanda pode ser entendida pela timeline sem depender da cidade 3D.

## Fase 8 — Métricas e aprendizado controlado

### Objetivo

Melhorar agentes com evidências, não com autoalteração irrestrita.

### Escopo

- Definir métricas e metas.
- Criar conjunto de testes de regressão.
- Registrar propostas de melhoria.
- Criar publicação gradual e rollback.
- Exigir aprovação humana ou de governança.

### Critério de aceite

Uma mudança de skill, prompt ou política só chega à produção após avaliação, testes, aprovação e histórico.

## Fase 9 — Segurança e produção

### Objetivo

Preparar acesso remoto seguro e operação contínua.

### Escopo

- Autenticação de produção.
- MFA para papéis críticos.
- RBAC.
- domínio e HTTPS;
- segredos por ambiente;
- banco privado;
- backups e restauração;
- monitoramento e alertas;
- rate limiting;
- resposta a incidentes.

### Critério de aceite

O sistema pode ser acessado em outros dispositivos por usuários autorizados, sem expor banco, segredos ou dados de outras pessoas.

## Primeiro pedido ao Claude Code

~~~text
Leia CLAUDE.md e toda a documentação importada. Inspecione o repositório sem editar. Compare o estado real com a Fase 0 e a Fase 1, liste divergências, arquivos afetados, migrations necessárias, riscos e plano de rollback. Não faça alterações antes de apresentar o plano.
~~~

## Primeiro pedido após aprovação

~~~text
Aprovado o plano da Fase 1. Implemente somente o Modelo Operacional Auditável, preservando o fluxo atual. Use migrations aditivas, registre eventos reais, crie o endpoint inicial do dossiê e adicione testes. Antes de cada alteração estrutural, explique a compatibilidade com as tabelas existentes.
~~~
