# Instruções permanentes — Frota de Agentes

Leia estes documentos antes de editar código:

@README.md
@docs/PROJECT_CONTEXT.md
@docs/ARCHITECTURE.md
@docs/IMPLEMENTATION_ROADMAP.md
@docs/EVENT_TAXONOMY.md
@docs/DOSSIER_SPEC.md
@docs/POLICY_AND_SECURITY.md
@docs/AGENT_AND_KNOWLEDGE.md
@docs/VALIDATION_AND_OPERATIONS.md

## Objetivo

Evoluir a Frota de Agentes para uma plataforma em nuvem, auditável e governada, que processa demandas por agentes especializados, coordenadores, políticas executáveis, bases de conhecimento versionadas e intervenção humana quando necessária.

## Contexto técnico conhecido

- Stack atual: Node.js, TypeScript, Fastify, PostgreSQL, pg-boss, Zod e SDK de modelo de linguagem.
- O backend já processa demandas por fila, registra runs, etapas, mensagens, relatórios, entregas, auditoria e aprendizado inicial.
- A estrutura atual de setores não deve ser removida de forma abrupta. Ela será migrada gradualmente para um catálogo real de agentes.
- A aplicação possui estados de demanda como Nova, Em andamento, Aguardando humano, Aguardando insumo, Concluída, Arquivada e Falhou. Confirme os nomes exatos no código antes de alterar.

## Regras de engenharia

1. Antes de qualquer alteração, leia o código relevante, as migrations e os testes.
2. Diferencie sempre fato implementado, protótipo visual e funcionalidade planejada.
3. Não reescreva processar-demanda, processar-fila ou migrations existentes sem necessidade comprovada.
4. Prefira migrations aditivas, compatíveis e reversíveis.
5. Preserve o fluxo atual de fila e os estados das demandas.
6. Não duplique dados já existentes em runs, agent_steps, mensagens, relatórios ou entregas sem documentar a razão.
7. Use TypeScript estrito, Zod para contratos externos e SQL parametrizado.
8. Não grave raciocínio interno bruto de modelos. Grave decisões operacionais resumidas, evidências e metadados auditáveis.
9. Não exponha segredos, dados pessoais, anexos privados ou prompts completos em logs, eventos ou SSE.
10. Não introduza uma dependência sem justificar o motivo e a alternativa descartada.
11. Não implemente a cidade 3D antes da estabilidade do evento persistido e da API de leitura.
12. Não crie 200 processos fixos. Agentes são registros de catálogo; workers executam somente os agentes necessários.
13. Não permita mudança automática de prompt, skill ou política em produção.
14. Não ative bloqueios de Policy Engine antes de executar em modo shadow e validar os resultados.

## Protocolo de trabalho

Antes de editar:

1. Execute git status.
2. Inspecione README, package.json, migrations, orquestradores, HTTP e testes.
3. Explique o estado atual, a divergência em relação ao alvo, os arquivos afetados, os riscos e o plano.
4. Aguarde aprovação humana antes de uma mudança estrutural.

Durante a implementação:

1. Faça uma alteração vertical pequena por vez.
2. Adicione ou atualize testes proporcionais ao risco.
3. Rode typecheck e testes relevantes.
4. Não altere arquivos não relacionados.
5. Registre decisões novas em docs/adr quando alterarem arquitetura, segurança, dados ou operação.

Ao final de cada fase, informe:

- arquivos alterados;
- comportamento entregue;
- migrations criadas;
- testes executados e resultado;
- riscos restantes;
- instruções de rollback;
- próximo passo recomendado.

## Prioridade absoluta

Implementar primeiro o Modelo Operacional Auditável:

demanda existente
→ processamento atual
→ eventos persistidos
→ auditoria
→ relatórios
→ dossiê consultável

Somente depois evoluir Policy Engine, cadastro real de agentes, skills, conhecimento, SSE, interface Em Operação, cidade 3D e aprendizado controlado.
