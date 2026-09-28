# Handoff para Claude Code

## Antes de iniciar

1. Copie CLAUDE.md e a pasta docs para a raiz do repositório.
2. Confira se nenhum documento contém segredo, token, senha, URL privada ou dado de cliente.
3. Faça um commit somente da documentação, separado das mudanças de código.
4. Abra o Claude Code na raiz do repositório.

## Primeira mensagem

~~~text
Leia CLAUDE.md e todos os documentos importados. Não altere arquivos ainda.

Inspecione o repositório e apresente:

1. arquitetura real atual;
2. fluxo real de uma demanda;
3. tabelas, migrations e relações existentes;
4. testes e comandos disponíveis;
5. divergências entre o código e a documentação;
6. plano da Fase 0 e Fase 1;
7. arquivos que seriam alterados;
8. migrations necessárias;
9. riscos, compatibilidade e rollback.

Priorize o Modelo Operacional Auditável: eventos persistidos e dossiê.
Não comece Policy Engine enforce, cidade 3D, catálogo de 200 agentes ou aprendizado autônomo.
Não faça alterações até receber aprovação explícita.
~~~

## Mensagem de aprovação da Fase 1

~~~text
Aprovado o plano da Fase 1. Implemente somente o Modelo Operacional Auditável.

Preserve o fluxo atual de fila e processamento. Use migrations aditivas. Reaproveite runs, agent_steps, mensagens, relatórios e entregas quando possível. Não exponha chain-of-thought, segredos ou dados sensíveis em eventos ou dossiês.

Antes de aplicar qualquer migration, explique a compatibilidade com o banco existente. Ao final, execute typecheck e testes relevantes, apresente o diff, os resultados, riscos restantes e rollback.
~~~

## Ordem de autorização

1. Fase 0: somente análise.
2. Fase 1: eventos e dossiê.
3. Fase 2: Policy Engine em shadow.
4. Fase 3: catálogo de agentes.
5. Fase 4: skills e conhecimento.
6. Fase 5: SSE e tela Em Operação.
7. Fase 6: regras em enforce.
8. Fase 7: cidade 3D.
9. Fase 8: aprendizado controlado.
10. Fase 9: endurecimento final de produção.

## Perguntas que exigem pausa

O Claude Code deve parar e solicitar decisão humana quando:

- uma migration for destrutiva;
- uma mudança alterar estados existentes;
- uma ferramenta externa precisar de nova credencial;
- houver dúvida sobre licença ou fonte de conhecimento;
- uma regra de política puder bloquear produção;
- uma mudança ampliar acesso a dados pessoais ou confidenciais;
- for necessário escolher entre dois modelos de autenticação;
- uma dependência nova tiver impacto de custo, segurança ou lock-in.
