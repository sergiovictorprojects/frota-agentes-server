# Contexto do Produto

## Propósito

A Frota de Agentes é uma aplicação em nuvem para executar demandas por meio de uma frota de agentes especializados. A plataforma deve atender demandas de forma rastreável, mensurável, auditável e sujeita a limites éticos e operacionais.

O produto não deve ser tratado apenas como um conjunto de prompts. Ele é um sistema operacional de trabalho composto por fila, agentes, coordenadores, políticas, conhecimento, auditoria, intervenção humana, evidências, métricas e entregas.

## Visão de produto

O usuário registra uma demanda. O sistema valida, classifica e avalia risco. Em seguida, o orquestrador seleciona agentes aptos, skills e fontes de conhecimento autorizadas. As etapas são executadas sob supervisão de políticas, coordenadores e, quando necessário, uma pessoa responsável.

Validação e roteamento são decisões auditáveis: a categoria não deve ser aceita apenas porque foi selecionada no
formulário. O sistema registra o resultado esperado e os critérios de aceite, aplica regras determinísticas de
compatibilidade e pode recomendar papéis. Em caso de ambiguidade ou conflito, exige confirmação humana; um modelo
nunca autoriza sozinho uma rota, um custo ou uma publicação.

Ao término, a plataforma gera:

- entrega final;
- relatórios por agente;
- relatório do coordenador;
- auditoria técnica, ética e de qualidade;
- métricas de operação;
- dossiê detalhado e consultável;
- sugestões de melhoria versionadas e testáveis.

## Experiência desejada

### Tela Em Operação

Apresenta o workflow em tempo real de maneira simples:

- demanda ativa e prioridade;
- agentes ativos, ociosos, suspensos e sob demanda;
- etapa atual e dependências;
- alertas de política, falhas e revisões;
- decisões operacionais resumidas;
- relatórios parciais;
- tempo, custo e progresso;
- representação visual futura em cidade 3D.

### Dossiê da Demanda

Disponível durante e depois da execução. Deve permitir entender o que ocorreu sem expor cadeia de raciocínio interna de modelos.

O dossiê contém:

- objetivo e escopo;
- linha do tempo;
- participantes;
- etapas;
- entradas e saídas resumidas;
- evidências e fontes;
- políticas avaliadas;
- aprovações humanas;
- relatórios;
- auditorias;
- métricas;
- entrega;
- pendências;
- aprendizado recomendado.

## Agentes

O número de agentes não corresponde a processos permanentemente ativos. O catálogo pode conter mais de 200 agentes, mas cada um terá um estado controlado:

- active: apto a receber trabalho;
- idle: ativo, mas sem demanda atual;
- on_demand: ativado somente quando sua capacidade for necessária;
- suspended: indisponível por decisão operacional;
- retired: preservado para histórico, sem novas execuções.

Agentes serão organizados por capacidade, setor, risco, permissões, skills, ferramentas, modelo e coordenador responsável.

## Governança

O sistema possui limites éticos e operacionais inspirados por práticas organizacionais, auditoria, melhoria contínua e referências como Lean e Six Sigma. Essas diretrizes devem evoluir de documento de conduta para regras verificáveis por software.

## O que já é conhecido como implementado

Esta lista deve ser verificada no código antes de mudar algo:

- Backend Node.js e TypeScript.
- API Fastify.
- PostgreSQL.
- Fila baseada em pg-boss.
- Processamento de demandas 24 horas.
- Registro de demandas, mensagens, relatórios, aprendizado, runs, etapas e entregas.
- Auditoria posterior à execução.
- Estados de demanda e tratamento de insumo ou revisão humana.
- Controle de orçamento e pausa operacional.
- Interface HTTP com autenticação básica para o ambiente atual.

## O que é alvo futuro

- Catálogo individual de agentes.
- Skills e conhecimento versionados.
- Registro granular de eventos operacionais.
- Dossiê consolidado por demanda.
- Policy Engine executável.
- SSE para tempo real.
- Relatórios por agente e coordenador.
- Métricas maduras e avaliação de qualidade.
- Visualização 3D baseada em eventos reais.
- Autenticação e autorização de produção.
- Aprendizado controlado com testes, aprovação e rollback.

## Princípios inegociáveis

1. A política e a segurança não podem depender apenas de instruções de prompt.
2. Toda ação relevante precisa ser auditável.
3. Dados sensíveis devem ser minimizados, protegidos e redigidos quando necessário.
4. Um humano deve poder revisar, interromper e aprovar decisões relevantes.
5. A evolução de agentes deve ser versionada, testada e reversível.
6. A cidade 3D é uma projeção da operação, não a operação em si.
