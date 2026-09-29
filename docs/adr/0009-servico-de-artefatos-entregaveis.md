# ADR 0009 — Serviço de artefatos entregáveis

## Status

Implementado em 2026-09-29 como reconstrução funcional do commit perdido `137de00`.

## Contexto

A frota produzia somente conteúdo para a página hospedada. O modelo não deve produzir bytes arbitrários nem
decidir MIME, extensão, hash ou cabeçalhos HTTP. Além disso, `artefatos_tarefa` (migration 006) é contexto
interno da orquestração, limitado a `texto/json`, e não pode ganhar uma segunda responsabilidade.

## Decisão

1. O contrato de execução pode propor até cinco arquivos por `nomeArquivo`, `formato` e `conteudo`. Se o pedido
   não exigir arquivo, o array é vazio. O servidor renderiza e valida os bytes.
2. São suportados 17 formatos: PDF, DOCX, XLSX, PPTX, CSV, TSV, JSON, YAML, XML, SQL, TXT, Markdown, HTML, SVG,
   ICS, VCF e ZIP. PDF e pacotes Open XML são construídos pelo servidor; ZIP é determinístico e sem compressão.
3. A migration 007 cria `artefatos_entregaveis`, sem alterar a 006. Cada arquivo se vincula simultaneamente à
   demanda e à entrega final e grava ordem, formato, nome seguro, MIME, bytes, SHA-256, gerador, publicador,
   classificação e data. O conteúdo fica em `bytea`, limitado a 5 MiB por arquivo nesta primeira versão.
4. O banco repete os invariantes de tamanho, hash, MIME, extensão, vínculo, capacidade do gerador e autoridade
   do publicador. Os registros são append-only. A entrega e seus arquivos são criados na mesma transação.
5. O catálogo persiste `gerar_artefatos`, `publicar_artefatos`, `ler_anexos` e limites por agente. Toda mudança
   nesses campos incrementa a versão e entra em `agentes_historico`. Executores geram apenas formatos de sua
   especialidade; somente o coordenador ativo publica; auditor não gera; `ler_anexos` permanece falso.
6. O detalhe e o dossiê mostram somente metadados e links. O download exige a autenticação Basic da interface,
   usa `Content-Disposition: attachment`, MIME validado, `nosniff`, CSP `sandbox`, ETag pelo SHA-256 e `no-store`.
7. Conteúdo ativo/externo em HTML e SVG, entidades/DOCTYPE em XML, caminhos em ZIP e fórmulas em células são
   bloqueados ou neutralizados. O modelo nunca fornece binário ou base64.

## Limites e próximos passos

- Ler anexos continua fora do escopo. A evolução exige upload autenticado, quarentena/antivírus, limites,
  extração isolada, normalização e defesa contra prompt injection.
- Arquivos grandes e retenção de longo prazo devem migrar para armazenamento de objetos. O `bytea` atual é uma
  decisão deliberada para arquivos finais pequenos, com limite estrito e atomicidade com a entrega.
- Não existe publicação externa nem URL pública de arquivo; o coordenador apenas autoriza a publicação interna.

## Rollback

O código pode deixar de solicitar e listar arquivos sem afetar entregas antigas. A tabela é append-only e não é
apagada no rollback operacional. A migration 006 e seus artefatos intermediários permanecem inalterados.
