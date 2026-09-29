# ADR 0005 — Links de entrega verificados na tabela `entregas`

## Status

Implementada no hotfix `hotfix/url-entregas-segura` (P0).

## Contexto

Uma entrega interna foi gravada como `https://frota.exemplo.com/entregas/<uuid>`: o valor de exemplo do
`.env.example` chegou a `PUBLIC_BASE_URL`, `hospedarEntrega()` gravou a URL absoluta em
`demandas.entrega_url` e `relatorios.entrega_url`, e a interface (`linkSeguro()`) aceitava qualquer URL
`http(s)` como "Abrir entrega". O link levou o usuário a um site externo, embora a entrega estivesse no banco.

Há também links legados deliberadamente externos: a importação do sistema antigo (`src/legacy/importar.ts`)
grava links `https://claude.ai/artifact/...`, que não são entregas hospedadas aqui.

## Decisão

1. **Boot fail-closed.** `PUBLIC_BASE_URL` precisa ser só uma origem (sem credenciais, caminho, query ou
   fragmento), em `https:`; `http:` só em `localhost`, `127.0.0.1` e `[::1]`. Domínios de documentação
   (`exemplo.com`, `example.com`, `example.net`, `example.org` e afins, com subdomínios) e TLDs reservados
   (`.example`, `.invalid`, `.test`, `.localhost`) são recusados. O `.env.example` usa
   `https://frota.example.invalid`, que o boot recusa: copiar o exemplo sem editar não sobe o serviço.
2. **A fonte de verdade de uma entrega interna é a tabela `entregas`, não o texto de `entrega_url`.** A UI
   extrai o UUID de uma URL com caminho exato `/entregas/<uuid>` na origem configurada ou num host de
   exemplo, e só exibe "Abrir entrega" se esse UUID existe em `entregas` com o mesmo `demanda_id` da demanda
   exibida. O `href` é relativo e montado a partir do registro. Nem o host gravado nem o header `Host`
   da requisição participam.
3. **Artefato externo legado tem tratamento explícito.** Só `https://claude.ai/...` é mostrado, com o rótulo
   "Abrir artefato externo (claude.ai)" e `rel="noopener noreferrer"`. Qualquer outro valor vira o texto
   "Link de entrega não verificado", sem `href`.
4. **O formato persistido não muda.** Entregas novas continuam gravadas como URL absoluta com a origem
   validada, e o e-mail de resumo continua usando essa URL. Nenhuma migration e nenhum dado alterado.

## Consequências

- Links antigos com `frota.exemplo.com` voltam a abrir a entrega certa, desde que ela seja da mesma demanda.
- Um UUID de entrega de outra demanda, um UUID inexistente, um host arbitrário, `javascript:`, `data:` ou URL
  protocol-relative nunca viram link.
- Rollback de código é seguro: as URLs gravadas durante o hotfix continuam válidas para o `linkSeguro()`
  anterior.
- Se o domínio público mudar no futuro, URLs gravadas com o domínio antigo (não reservado) passam a aparecer
  como "não verificado". A normalização histórica de `entrega_url` fica para uma decisão posterior, com
  inventário dos registros atingidos.
- Uma consulta a mais por página (em lote, pela chave primária de `entregas`).

## Alternativas descartadas

- **Gravar caminho relativo em `entrega_url` já neste hotfix:** muda o contrato persistido e deixaria as
  entregas novas invisíveis se o código fosse revertido.
- **Reconhecer a entrega interna só pelo texto do caminho:** um UUID de outra demanda viraria link.
- **Migration de limpeza dos links `frota.exemplo.com`:** adiada; a correção de leitura resolve o incidente
  sem tocar dados.
