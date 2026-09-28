# Fluxogramas Operacionais

Estes fluxos descrevem a visão final. Os elementos ainda não implementados devem ser tratados como alvo de desenvolvimento, não como comportamento existente.

## 1. Fluxo final do produto

~~~mermaid
flowchart TD
    A["Demanda recebida"] --> B["Autenticação, validação e classificação"]
    B --> C["Policy Engine inicial"]
    C --> D{"Permitida?"}
    D -- "Não" --> E["Bloquear e registrar motivo"]
    E --> F["Revisão humana ou arquivamento"]
    D -- "Sim" --> G["Criar run idempotente"]
    G --> H["Persistir evento inicial"]
    H --> I["Orquestrador cria plano"]
    I --> J["Selecionar agentes, skills e fontes"]
    J --> K["Executar etapas"]
    K --> L["Avaliar política durante a ação"]
    L --> M{"Exige revisão?"}
    M -- "Sim" --> N["Pausar e solicitar humano"]
    N --> O{"Aprovação concedida?"}
    O -- "Não" --> P["Replanejar, cancelar ou falhar"]
    O -- "Sim" --> K
    M -- "Não" --> Q["Persistir resultados e evidências"]
    Q --> R{"Há próxima etapa?"}
    R -- "Sim" --> I
    R -- "Não" --> S["Relatório do coordenador"]
    S --> T["Auditoria final"]
    T --> U{"Conforme?"}
    U -- "Não" --> V{"Pode corrigir?"}
    V -- "Sim" --> I
    V -- "Não" --> P
    U -- "Sim" --> W["Policy Engine final"]
    W --> X["Gerar entrega"]
    X --> Y["Fechar run"]
    Y --> Z["Criar snapshot do dossiê"]
    Z --> AA["Métricas e avaliação"]
    AA --> AB["Melhoria controlada"]
~~~

## 2. Entrada e fila

~~~mermaid
flowchart TD
    A["Usuário ou integração envia demanda"] --> B["Validar campos, anexos e permissão"]
    B --> C{"Dados válidos?"}
    C -- "Não" --> D["Registrar pendência e retornar ao solicitante"]
    C -- "Sim" --> E["Classificar prioridade, setor e SLA"]
    E --> F["Gravar demanda"]
    F --> G["Status Nova"]
    G --> H["Publicar job na fila"]
    H --> I["Worker verifica pausa e capacidade"]
    I --> J{"Pode processar?"}
    J -- "Não" --> K["Aguardar próximo ciclo"]
    K --> I
    J -- "Sim" --> L["Criar run e reivindicar demanda"]
    L --> M["Status Em andamento"]
    M --> N["Registrar demand_claimed"]
    N --> O["Enviar ao orquestrador"]
~~~

## 3. Orquestração e agentes

~~~mermaid
flowchart TD
    A["Run operacional"] --> B["Interpretar objetivo e restrições"]
    B --> C["Criar plano de etapas"]
    C --> D["Resolver capacidades necessárias"]
    D --> E["Selecionar agente elegível"]
    E --> F{"Agente disponível?"}
    F -- "Ativo ou ocioso" --> G["Executar etapa"]
    F -- "Sob demanda" --> H["Ativar com registro e limite"]
    H --> G
    F -- "Suspenso ou sem capacidade" --> I["Escalonar ao coordenador"]
    G --> J["Registrar entrada, saída, custo e duração"]
    J --> K["Avaliar política"]
    K --> L{"Próxima etapa?"}
    L -- "Sim" --> M["Revisão parcial do coordenador"]
    M --> D
    L -- "Não" --> N["Consolidar relatório do coordenador"]
~~~

## 4. Conhecimento e skills

~~~mermaid
flowchart TD
    A["Etapa selecionada"] --> B["Identificar conhecimento necessário"]
    B --> C["Resolver skill ativa e versionada"]
    C --> D["Consultar bases autorizadas"]
    D --> E["Recuperar trechos relevantes"]
    E --> F["Validar licença, fonte e classificação"]
    F --> G{"Permitido e confiável?"}
    G -- "Não" --> H["Marcar risco e solicitar alternativa"]
    G -- "Sim" --> I["Montar contexto limitado"]
    I --> J["Executar agente com referências"]
    J --> K["Registrar fontes e versões"]
    K --> L["Incluir evidências no relatório"]
~~~

## 5. Policy Engine

~~~mermaid
flowchart TD
    A["Ação proposta"] --> B["Identificar recurso, dados, ferramenta e risco"]
    B --> C["Carregar regras aplicáveis"]
    C --> D["Avaliar permissões e condições"]
    D --> E{"Decisão"}
    E -- "allow" --> F["Liberar ação"]
    E -- "warn" --> G["Liberar e registrar alerta"]
    E -- "require_approval" --> H["Pausar para aprovação humana"]
    E -- "deny" --> I["Bloquear ação"]
    F --> J["Persistir avaliação"]
    G --> J
    H --> K{"Aprovada?"}
    K -- "Sim" --> J
    K -- "Não" --> L["Replanejar ou encerrar"]
    I --> M["Registrar violação e severidade"]
    J --> N["Prosseguir com a etapa"]
~~~

## 6. Modo Em Operação

~~~mermaid
flowchart LR
    A["Agente executa"] --> E["agent_events"]
    B["Coordenador revisa"] --> E
    C["Policy Engine avalia"] --> E
    D["Auditoria registra"] --> E
    E --> F["PostgreSQL: timeline"]
    E --> G["SSE com cursor e replay"]
    G --> H["Tela Em Operação"]
    H --> I["Lista de agentes e status"]
    H --> J["Detalhe da etapa"]
    H --> K["Alertas e aprovações"]
    H --> L["Projeção 3D"]
    F --> M["Dossiê em andamento"]
~~~

## 7. Intervenção humana

~~~mermaid
flowchart TD
    A["Risco, ambiguidade ou falta de insumo"] --> B["Criar human_review_required"]
    B --> C["Atualizar estado da demanda"]
    C --> D["Notificar responsável"]
    D --> E["Exibir contexto, evidências e política"]
    E --> F{"Decisão humana"}
    F -- "Fornecer insumo" --> G["Registrar resposta"]
    F -- "Aprovar" --> H["Registrar escopo e aprovação"]
    F -- "Rejeitar" --> I["Registrar motivo"]
    G --> J["Retomar etapa"]
    H --> J
    I --> K["Replanejar, arquivar ou falhar"]
~~~

## 8. Auditoria e dossiê

~~~mermaid
flowchart TD
    A["Resultado da execução"] --> B["Auditoria técnica e de qualidade"]
    B --> C["Verificar regras do setor e políticas"]
    C --> D["Verificar evidências e fontes"]
    D --> E["Calcular métricas"]
    E --> F{"Conforme?"}
    F -- "Não" --> G["Correção ou revisão humana"]
    G --> H["Nova tentativa controlada"]
    F -- "Sim" --> I["Aprovar entrega"]
    I --> J["Consolidar relatórios"]
    J --> K["Gerar linha do tempo"]
    K --> L["Criar snapshot do dossiê"]
    L --> M["Permitir consulta e exportação autorizada"]
~~~

## 9. Aprendizado controlado

~~~mermaid
flowchart TD
    A["Dossiê encerrado"] --> B["Extrair resultados e métricas"]
    B --> C["Identificar padrão de acerto ou falha"]
    C --> D["Propor melhoria de skill, prompt ou política"]
    D --> E["Criar versão isolada"]
    E --> F["Executar testes de regressão"]
    F --> G{"Melhora sem violar regras?"}
    G -- "Não" --> H["Descartar e registrar motivo"]
    G -- "Sim" --> I["Revisão humana ou de governança"]
    I --> J{"Aprovada?"}
    J -- "Não" --> H
    J -- "Sim" --> K["Publicação gradual"]
    K --> L["Monitorar e permitir rollback"]
    L --> A
~~~

## Observação sobre a cidade 3D

A cidade 3D deve ser uma leitura visual da projeção de eventos:

- distritos representam áreas ou bases de conhecimento;
- edifícios representam setores;
- barras ou torres representam agentes;
- conexões representam dependências ou comunicação;
- cores representam estado e risco;
- o núcleo central representa fila, orquestração e governança.

Ela não pode ser usada como fonte de dados nem possuir lógica de negócio própria.
