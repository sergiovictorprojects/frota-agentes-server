# ADR 0001 — Evolução incremental e auditável

## Status

Aceita como orientação inicial. Deve ser revisada após a Fase 0.

## Contexto

O backend atual já contém fila, processamento, auditoria e tabelas operacionais. A visão futura adiciona agentes individuais, eventos, dossiês, políticas, skills, tempo real, visualização 3D e aprendizado.

Uma reescrita completa criaria risco de regressão, atraso e perda de comportamento já funcional.

## Decisão

Evoluir por migrations aditivas e fatias verticais:

1. Eventos e dossiê.
2. Policy Engine em shadow.
3. Catálogo de agentes.
4. Skills e conhecimento.
5. Tempo real.
6. Enforce de políticas.
7. Visualização 3D.
8. Aprendizado controlado.

## Consequências

### Positivas

- Menor risco de quebrar fila e processamento atual.
- Evidência de valor em cada fase.
- Melhor depuração.
- Rollback mais simples.
- Dados reais disponíveis antes da visualização.

### Custos

- Período de coexistência entre estrutura atual e nova.
- Necessidade de documentação e testes disciplinados.
- Possível adaptação temporária entre setores e agentes.

## Reversibilidade

Cada fase deve preferir criação de tabelas, colunas e rotas novas. Não apagar ou renomear estruturas atuais até que haja migração comprovada, cobertura de testes e plano de retorno.
