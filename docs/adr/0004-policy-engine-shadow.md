# ADR 0004 — Policy Engine em modo shadow antes de enforcement

## Status

Implementada na Fase 2 — Entrega 2.

## Contexto

`docs/POLICY_AND_SECURITY.md` já define o modelo alvo do Policy Engine: avaliação em três estágios
(`pre`/`during`/`post`), quatro decisões possíveis (`allow`/`warn`/`require_approval`/`deny`), e um "modo
de ativação" com três fases — `shadow` (avalia e registra, sem bloquear), `warn` (exibe alertas) e
`enforce` (bloqueia regras críticas já validadas). Este ADR documenta a decisão de implementar **só o modo
shadow** nesta entrega, com um motor determinístico completo por baixo dele, e deixar `enforce` para uma
entrega futura.

## Decisão

Implementar o Policy Engine (`politicas`, `regras_politica`, `avaliacoes_politica`, migration
`004_policy_engine.sql`) rodando exclusivamente em modo shadow: toda avaliação é registrada, nenhuma
altera o comportamento observável de uma demanda.

## Por quê

Um motor de bloqueio real (`enforce`) só é seguro de ativar depois que alguém confia que suas regras não
vão travar produção por um falso positivo. Essa confiança não existe no dia em que o motor nasce — só se
constrói observando decisões reais contra tráfego real, sem agir sobre elas, por tempo suficiente para
notar se uma regra dispararia em casos que não deveria.

Ativar `enforce` no primeiro dia trocaria um risco conhecido (nenhuma política automatizada ainda,
situação atual) por um risco pior e desconhecido: uma regra mal calibrada bloqueando toda a fila de
produção, sem histórico prévio que mostrasse isso vinha. Shadow inverte essa ordem — o motor entra em
produção primeiro como observador, e só ganha poder de bloquear depois que os dados que ele mesmo gerou
(`avaliacoes_politica`) provarem que suas decisões fazem sentido.

## O motor já é o motor real — só a ação que falta

Uma decisão de design importante: **o motor de decisão não é um stub ou uma versão simplificada** que
será substituída quando `enforce` chegar. `avaliarEregistrar()` já roda a lógica de correspondência
determinística completa (allowlist estruturada, severidade entre regras que casam, versionamento de
regra) — a única coisa que muda em uma entrega futura de `enforce` é o que o **chamador** (o orquestrador)
faz com o valor que `avaliarEregistrar()` já retorna hoje: hoje é ignorado; em `enforce`, uma chamada com
`decisao === 'deny'` (e, dependendo da regra, `'require_approval'`) passaria a de fato interromper a
chamada ao modelo ou pausar a demanda. Nenhuma migration nova, nenhuma mudança no schema de `condicao`
deveria ser necessária só para isso — `enforce` é uma mudança no orquestrador, não no motor.

## Escopo desta entrega — o que NÃO foi implementado

Deliberadamente fora, para manter esta entrega mínima e reversível:

- **Bloqueio real (modo enforce)** — uma regra com `decisao: 'deny'` é registrada normalmente em
  `avaliacoes_politica` e emite o evento `politica_avaliada`, mas a chamada ao modelo de execução ou
  auditoria acontece de qualquer forma. Nada no orquestrador ramifica no valor de retorno de
  `avaliarEregistrar()`.
- **Aprovações humanas reais** — `require_approval` é só mais um valor de `decisao` registrado; não existe
  fila de aprovação, não existe pausa da demanda esperando uma decisão humana.
- **UI de administração de políticas** — criar políticas e regras hoje é só via as funções de
  `src/db/politicas.ts`, chamadas por script ou console. Não há rota HTTP.
- **Qualquer política pré-carregada** — diferente do catálogo de agentes (Fase 2, Entrega 1, que semeia os
  19 agentes de `SETORES` no boot), o Policy Engine não semeia nenhuma política. O catálogo nasce vazio, e
  o motor em produção hoje sempre decide `allow` até que alguém crie uma política e uma regra.
- **Modo "warn"** (a fase intermediária entre shadow e enforce, de `docs/POLICY_AND_SECURITY.md`) — não
  implementado como um modo de ativação separado nesta entrega; `warn` já existe como um valor de
  `decisao` possível (registrado normalmente em modo shadow), mas o conceito de "exibir alertas de verdade
  para um operador" não tem nenhuma superfície nesta entrega (sem UI, sem notificação).

## Consequências

- Quando `enforce` for implementado, ele consome `avaliacoes_politica` como evidência histórica — pode
  responder "se esta regra estivesse em enforce nos últimos 30 dias, quantas vezes ela teria bloqueado
  algo, e isso fazia sentido?" antes de ativar de verdade, porque o motor já vinha registrando isso desde
  o primeiro dia desta entrega.
- Qualquer regra criada hoje, mesmo com `decisao: 'deny'`, é inerte em produção — segura de criar e testar
  em ambiente real sem risco de travar a fila. Isso é uma propriedade desejável do design, não um efeito
  colateral: dá espaço para calibrar regras contra tráfego real antes de qualquer coisa depender delas.
- `agentes.papel`/`categoria`/`estado`/`modelo_permitido` (Fase 2, Entrega 1) já são exatamente os campos
  que a allowlist de condição usa — o Policy Engine não precisou inventar um vocabulário novo, reaproveitou
  o que o catálogo de agentes já validava.

## Reversibilidade

Migration aditiva; nenhuma tabela existente foi alterada. Reverter significa remover as três chamadas de
`avaliarEstagio()` em `processar-demanda.ts` (que hoje nunca alteram o comportamento observável de nenhuma
demanda) e, se necessário, dropar as quatro tabelas novas — sem impacto em `demandas`, `agentes`,
`agent_events` ou qualquer outra tabela de domínio.
