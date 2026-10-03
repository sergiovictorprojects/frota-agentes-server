import type { Demanda } from '../../db/demandas.ts';
import type { ArtefatoEntregavelResumo } from '../../db/artefatos-entregaveis.ts';
import type { ResumoCustoDemanda } from '../../db/custos.ts';
import type { Evento } from '../../db/eventos.ts';
import type { Mensagem } from '../../db/mensagens.ts';
import type { Relatorio } from '../../db/relatorios.ts';
import {
  estimativasBasePorComplexidade,
  ROTULOS_COMPLEXIDADE_DEMANDA,
  type EstimativaUsoDemanda,
} from '../../domain/estimativa-demanda.ts';
import type { LinkEntrega } from '../../domain/links-entrega.ts';
import { RESULTADOS_ESPERADOS, ROTULOS_RESULTADO_ESPERADO } from '../../domain/resultado-esperado.ts';
import { CATEGORIAS, PRIORIDADES, SETORES, STATUS, type StatusDemanda } from '../../domain/setores.ts';
import { bruto, html, type Bruto } from './html.ts';
import { formatarData } from './layout.ts';

const CLASSE_STATUS: Readonly<Record<StatusDemanda, string>> = {
  Nova: 'nova',
  'Em andamento': 'andamento',
  'Aguardando humano': 'espera',
  'Aguardando insumo': 'espera',
  Concluída: 'ok',
  Arquivada: 'arquivada',
  Falhou: 'erro',
};

const chip = (status: StatusDemanda): Bruto => html`<span class="chip ${CLASSE_STATUS[status]}">${status}</span>`;
// O link já chega resolvido pela rota (src/http/ui/links-entrega.ts): esta função só o renderiza. Apenas
// uma entrega confirmada em `entregas` recebe o rótulo "Abrir entrega"; artefato externo legado tem rótulo
// próprio, e um link não verificado nunca vira href.
function linkDeEntrega(link: LinkEntrega | null | undefined, classe = ''): Bruto | '' {
  if (!link) return '';
  const atributoClasse = classe ? bruto(` class="${classe}"`) : '';
  if (link.tipo === 'interna') return html`<a${atributoClasse} href="${link.href}">Abrir entrega</a>`;
  if (link.tipo === 'externa_legada') {
    return html`<a${atributoClasse} href="${link.href}" rel="noopener noreferrer">Abrir artefato externo (${link.host})</a>`;
  }
  return html`<span class="vazio">Link de entrega não verificado</span>`;
}
const numero = (n: number | null | undefined, sufixo = ''): string => (n === null || n === undefined ? 'não medido' : `${n}${sufixo}`);
const usd = (valor: string): string => `US$ ${Number(valor).toFixed(2)}`;
const tokens = (valor: number): string => new Intl.NumberFormat('pt-BR').format(valor);

function tamanho(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function blocoArtefatos(artefatos: readonly ArtefatoEntregavelResumo[]): Bruto {
  if (!artefatos.length) return html`<p class="vazio">Nenhum arquivo entregável foi gerado.</p>`;
  return html`<ul class="lista">${artefatos.map((a) => html`<li class="card">
<h3><a href="/artefatos/${a.id}/download">${a.nomeArquivo}</a></h3>
<div class="meta"><span>${a.formato.toUpperCase()}</span><span>${tamanho(a.bytes)}</span><span>${a.classificacao}</span><span>gerado por ${a.geradoPor}</span><span>publicado por ${a.publicadoPor}</span><span>${formatarData(a.criadoEm)}</span><span>SHA-256 <code>${a.sha256}</code></span></div>
</li>`)}</ul>`;
}

function botaoAcao(acao: string, rotulo: string, secundario = false): Bruto {
  return html`<form method="post" action="${acao}"><button class="botao${secundario ? ' sec' : ''}" type="submit">${rotulo}</button></form>`;
}

function botaoExclusao(acao: string): Bruto {
  return html`<form method="post" action="${acao}" onsubmit="return confirm('Excluir esta demanda definitivamente? Esta ação remove a demanda e todos os dados relacionados da base.')"><button class="botao sec" type="submit">Excluir definitivamente</button></form>`;
}

function blocoEstimativasCriacao(): Bruto {
  const linhas = estimativasBasePorComplexidade().map(
    (e) => html`<tr>
<td>${ROTULOS_COMPLEXIDADE_DEMANDA[e.complexidade]}</td>
<td>${e.modoExecucao}</td>
<td>${e.chamadasLlmMin}–${e.chamadasLlmMax}</td>
<td>${tokens(e.tokensTotaisEstimados)}</td>
<td>${usd(e.orcamentoSugeridoUsd)}</td>
</tr>`,
  );
  return html`<section class="painel-custo" aria-labelledby="estimativa-uso">
<h2 id="estimativa-uso">Estimativa de uso</h2>
<p class="vazio">A previsão é determinística e não chama a API. O valor final da demanda criada também considera o tamanho da descrição, critérios e referências.</p>
<table class="tabela-custo">
<thead><tr><th>Complexidade</th><th>Modo</th><th>Chamadas LLM</th><th>Tokens estimados</th><th>Orçamento sugerido</th></tr></thead>
<tbody>${linhas}</tbody>
</table>
</section>`;
}

function blocoEstimativaDetalhe(e: EstimativaUsoDemanda): Bruto {
  return html`<dl class="info">
<dt>Complexidade</dt><dd>${ROTULOS_COMPLEXIDADE_DEMANDA[e.complexidade]}</dd>
<dt>Modo estimado</dt><dd>${e.modoExecucao}</dd>
<dt>Chamadas LLM</dt><dd>${e.chamadasLlmMin}–${e.chamadasLlmMax}</dd>
<dt>Tokens estimados</dt><dd>${tokens(e.tokensTotaisEstimados)} (${tokens(e.tokensEntradaEstimados)} entrada / ${tokens(e.tokensSaidaEstimados)} saída)</dd>
<dt>Custo estimado</dt><dd>${usd(e.custoEstimadoUsd)} em ${e.modeloReferencia}</dd>
<dt>Orçamento sugerido</dt><dd>${usd(e.orcamentoSugeridoUsd)}</dd>
</dl>`;
}

function blocoCustoReal(custo: ResumoCustoDemanda, estimativa: EstimativaUsoDemanda): Bruto {
  if (custo.chamadas === 0) return html`<p class="vazio">Ainda não há chamadas LLM registradas para esta demanda.</p>`;
  const estimado = Number(estimativa.custoEstimadoUsd);
  const real = Number(custo.custoUsd);
  const diferenca = real - estimado;
  const linhas = custo.porPapel.map(
    (p) => html`<tr>
<td><code>${p.papel}</code></td>
<td>${p.chamadas}</td>
<td>${tokens(p.tokensTotal)}</td>
<td>${usd(p.custoUsd)}</td>
<td>${p.duracaoMediaMs === null ? '—' : `${p.duracaoMediaMs} ms`}</td>
</tr>`,
  );
  return html`<dl class="info">
<dt>Chamadas reais</dt><dd>${custo.chamadas}</dd>
<dt>Tokens reais</dt><dd>${tokens(custo.tokensTotal)} (${tokens(custo.tokensEntrada)} entrada / ${tokens(custo.tokensSaida)} saída)</dd>
<dt>Custo real</dt><dd>${usd(custo.custoUsd)}</dd>
<dt>Comparação</dt><dd>${diferenca <= 0 ? 'Dentro da estimativa' : `Acima da estimativa em ${usd(diferenca.toFixed(6))}`}</dd>
</dl>
<table class="tabela-custo">
<thead><tr><th>Agente</th><th>Chamadas</th><th>Tokens</th><th>Custo</th><th>Duração média</th></tr></thead>
<tbody>${linhas}</tbody>
</table>`;
}

const ROTULOS_CAUSA_LLM: Readonly<Record<string, string>> = {
  auth: 'Credencial ou permissão',
  quota: 'Saldo ou cota',
  rate_limit: 'Limite de requisições',
  timeout: 'Tempo esgotado',
  overload: 'Sobrecarga do provedor',
  bad_request: 'Pedido inválido',
  nao_encontrado: 'Modelo ou rota não encontrados',
  servidor: 'Erro do provedor',
  rede: 'Rede ou conexão',
  desconhecida: 'Causa não identificada',
};

const ACOES_CAUSA_LLM: Readonly<Record<string, string>> = {
  auth: 'Revisar a chave da API e permissões do projeto antes de tentar novamente.',
  quota: 'Verificar saldo, limite mensal ou créditos da conta antes de retomar a frota.',
  rate_limit: 'Aguardar alguns minutos ou reduzir a frequência de execuções.',
  timeout: 'Tentar novamente com demanda menor ou timeout maior se repetir.',
  overload: 'Aguardar estabilização do provedor; retry automático é adequado, mas deve ser limitado.',
  bad_request: 'Revisar prompt, schema e tamanho da demanda; repetir sem ajuste tende a falhar de novo.',
  nao_encontrado: 'Conferir nome do modelo e configuração do provedor.',
  servidor: 'Aguardar estabilização do provedor e acompanhar novas tentativas.',
  rede: 'Checar conectividade do servidor e tentar novamente.',
  desconhecida: 'Consultar eventos e logs operacionais antes de insistir em novas tentativas.',
};

function textoMetadata(e: Evento, chave: string): string | null {
  const valor = e.metadata[chave];
  return typeof valor === 'string' ? valor : null;
}

function numeroMetadata(e: Evento, chave: string): number | null {
  const valor = e.metadata[chave];
  return typeof valor === 'number' ? valor : null;
}

function ultimoEventoComErro(eventos: readonly Evento[]): Evento | null {
  return [...eventos]
    .reverse()
    .find((e) => typeof e.metadata.codigoErro === 'string' || typeof e.metadata.causaLlm === 'string') ?? null;
}

function blocoDiagnosticoOperacional(eventos: readonly Evento[], custo: ResumoCustoDemanda): Bruto {
  const evento = ultimoEventoComErro(eventos);
  if (!evento) {
    return html`<section class="diagnostico ok">
<div><strong>Sem falhas registradas</strong><span>A demanda ainda não encontrou bloqueios operacionais.</span></div>
<span class="medidor">pronta</span>
</section>`;
  }
  const codigo = textoMetadata(evento, 'codigoErro') ?? '—';
  const causa = textoMetadata(evento, 'causaLlm');
  const statusHttp = numeroMetadata(evento, 'statusHttp');
  const rotuloCausa = causa ? (ROTULOS_CAUSA_LLM[causa] ?? causa) : codigo;
  const acao = causa ? (ACOES_CAUSA_LLM[causa] ?? ACOES_CAUSA_LLM.desconhecida) : 'Acompanhar a linha do tempo antes de nova tentativa.';
  const risco = causa === 'bad_request' || causa === 'auth' || causa === 'quota' ? 'acao' : 'retry';
  return html`<section class="diagnostico ${risco}">
<div>
<strong>${rotuloCausa}</strong>
<span>${acao}</span>
<small><code>${evento.tipoEvento}</code> · <code>${codigo}</code>${statusHttp ? html` · HTTP ${statusHttp}` : ''} · ${formatarData(evento.ocorridoEm)}</small>
</div>
<span class="medidor">${custo.chamadas} chamada(s)</span>
</section>`;
}

export function paginaFila(a: {
  demandas: readonly Demanda[];
  links: ReadonlyMap<string, LinkEntrega | null>;
  contagem: Partial<Record<StatusDemanda, number>>;
  filtro: StatusDemanda | null;
  pausado: boolean;
  podeExecutar: boolean;
}): Bruto {
  const filtros = [null, ...STATUS].map((s) => {
    const href = s ? `/?status=${encodeURIComponent(s)}` : '/';
    const total = s ? a.contagem[s] : null;
    return html`<a class="filtro${s === a.filtro ? ' ativo' : ''}" href="${href}">${s ?? 'Todas'}${total ? html` <span>${total}</span>` : ''}</a>`;
  });
  const cartoes = a.demandas.map((d) => {
    return html`<li class="card">
<h3><a href="/demandas/${d.id}">${d.titulo}</a> ${chip(d.status)}</h3>
<div class="meta"><span>${d.categoria} — ${SETORES[d.categoria].nome}</span><span>${d.prioridade}</span><span>${ROTULOS_COMPLEXIDADE_DEMANDA[d.complexidade]}</span><span>${usd(d.estimativaUso.orcamentoSugeridoUsd)}</span><span>${formatarData(d.criadoEm)}</span>${linkDeEntrega(a.links.get(d.id))}</div>
</li>`;
  });
  return html`<div class="cabecalho">
<div><h1>Fila de demandas</h1><p class="vazio">A frota processa a fila sozinha, em intervalos fixos.</p></div>
<div class="acoes">
${a.podeExecutar ? botaoAcao('/executar', 'Executar agora') : ''}
${a.pausado ? botaoAcao('/frota/retomar', 'Retomar frota') : botaoAcao('/frota/pausar', 'Pausar frota', true)}
</div>
</div>
<nav class="filtros" aria-label="Filtrar por status">${filtros}</nav>
${cartoes.length ? html`<ul class="lista">${cartoes}</ul>` : html`<p class="vazio">Nenhuma demanda aqui ainda. Crie a primeira em "Nova demanda".</p>`}`;
}

export function paginaNova(a: { valores: Readonly<Record<string, string>>; erros: readonly string[] }): Bruto {
  const v = (campo: string): string => a.valores[campo] ?? '';
  const opcao = (valor: string, rotulo: string, atual: string): Bruto =>
    html`<option value="${valor}"${valor === atual ? bruto(' selected') : ''}>${rotulo}</option>`;
  return html`<h1>Nova demanda</h1>
${a.erros.length ? html`<ul class="erros" role="alert">${a.erros.map((e) => html`<li>${e}</li>`)}</ul>` : ''}
<form class="campos" method="post" action="/demandas">
<label>Título<input name="titulo" required maxlength="200" value="${v('titulo')}"></label>
<label>Setor responsável<select name="categoria">${CATEGORIAS.map((c) => opcao(c, `${c} — ${SETORES[c].nome}`, v('categoria') || 'gestores'))}</select></label>
<label>Resultado esperado<select name="resultadoEsperado">${RESULTADOS_ESPERADOS.map((r) => opcao(r, ROTULOS_RESULTADO_ESPERADO[r], v('resultadoEsperado') || 'outro'))}</select></label>
<label>Complexidade do projeto<select name="complexidade">${estimativasBasePorComplexidade().map((e) => opcao(e.complexidade, `${ROTULOS_COMPLEXIDADE_DEMANDA[e.complexidade]} — ${usd(e.orcamentoSugeridoUsd)} sugerido`, v('complexidade') || 'MEDIUM'))}</select></label>
<label>Prioridade<select name="prioridade">${PRIORIDADES.map((p) => opcao(p, p, v('prioridade') || 'MEDIUM'))}</select></label>
<label>Prazo<input type="date" name="prazo" value="${v('prazo')}"></label>
<label>Solicitante<input name="solicitante" maxlength="200" value="${v('solicitante')}"></label>
<label>Descrição<textarea name="descricao" rows="16" maxlength="100000">${v('descricao')}</textarea></label>
<label>Critérios de aceite<textarea name="criteriosAceite" rows="5" maxlength="10000">${v('criteriosAceite')}</textarea></label>
<label>Referências<textarea name="referencias" rows="5" maxlength="20000">${v('referencias')}</textarea></label>
<div><button class="botao" type="submit">Criar demanda</button></div>
</form>
${blocoEstimativasCriacao()}`;
}

function blocoRelatorio(r: Relatorio | null): Bruto {
  if (!r) return html`<p class="vazio">Ainda não há relatório para esta demanda.</p>`;
  const m = r.metricas;
  return html`<dl class="info">
<dt>Executado por</dt><dd>${r.gerente}</dd>
<dt>Complexidade</dt><dd>nível ${r.nivelComplexidade}</dd>
<dt>Setores</dt><dd>${r.setoresEnvolvidos.join(', ') || '—'}</dd>
<dt>Índice geral</dt><dd>${numero(m.indiceGeral)}</dd>
<dt>Antipadrões auditados</dt><dd>${numero(m.antipadroesCount)}</dd>
<dt>Regras cumpridas</dt><dd>${numero(m.regrasCumpridasPercent, '%')}</dd>
<dt>Tempo</dt><dd>${m.tempoTotal}</dd>
<dt>Ações</dt><dd>${m.acoesRealizadas}</dd>
</dl>
${m.auditoriaFalhou ? html`<p class="aviso">A auditoria automática não terminou: os números de conformidade não foram calculados.</p>` : ''}
<h2>Ganhos</h2><p class="texto">${r.ganhos}</p>
<h2>Perdas</h2><p class="texto">${r.perdas}</p>
<h2>Aprendizado</h2><p class="texto">${r.aprendizado}</p>
${r.ponderacoes.length ? html`<h2>Ponderações</h2><ul>${r.ponderacoes.map((p) => html`<li><strong>${p.setor}</strong>: ${p.nota}</li>`)}</ul>` : ''}`;
}

export function paginaDetalhe(a: {
  demanda: Demanda;
  mensagens: readonly Mensagem[];
  relatorio: Relatorio | null;
  eventos: readonly Evento[];
  artefatos: readonly ArtefatoEntregavelResumo[];
  custo: ResumoCustoDemanda;
  linkEntrega: LinkEntrega | null;
}): Bruto {
  const d = a.demanda;
  const linhas = a.mensagens.map(
    (m) => html`<li><time datetime="${m.criadoEm}">${formatarData(m.criadoEm)}</time>
<span class="${m.autor === 'solicitante' ? 'solicitante' : 'agente'}">${m.autor === 'solicitante' ? 'Solicitante' : (m.agente ?? 'orquestrador')}</span>
<div class="texto">${m.texto}</div></li>`,
  );
  const aguardando = d.status === 'Aguardando humano' || d.status === 'Aguardando insumo';
  return html`<div class="cabecalho">
<div><h1>${d.titulo}</h1><div class="meta">${chip(d.status)}<span>${d.categoria} — ${SETORES[d.categoria].nome}</span><span>${d.prioridade}</span></div></div>
<div class="acoes">
${d.status === 'Falhou' ? botaoAcao(`/demandas/${d.id}/reabrir`, 'Tentar novamente') : ''}
${d.status !== 'Arquivada' && d.status !== 'Em andamento' ? botaoAcao(`/demandas/${d.id}/arquivar`, 'Arquivar', true) : ''}
${d.status !== 'Em andamento' ? botaoExclusao(`/demandas/${d.id}/excluir`) : ''}
</div>
</div>
${a.linkEntrega ? html`<p>${linkDeEntrega(a.linkEntrega, 'botao')}</p>` : ''}
<h2>Diagnóstico operacional</h2>
${blocoDiagnosticoOperacional(a.eventos, a.custo)}
<h2>Arquivos para download</h2>
${blocoArtefatos(a.artefatos)}
<p><a href="/demandas/${d.id}/dossie">Ver dossiê</a></p>
<dl class="info">
<dt>Solicitante</dt><dd>${d.solicitante ?? '—'}</dd>
<dt>Resultado esperado</dt><dd>${ROTULOS_RESULTADO_ESPERADO[d.resultadoEsperado]}</dd>
<dt>Critérios de aceite</dt><dd>${d.criteriosAceite || '—'}</dd>
<dt>Prazo</dt><dd>${d.prazo ?? '—'}</dd>
<dt>Criada em</dt><dd>${formatarData(d.criadoEm)}</dd>
<dt>Tentativas</dt><dd>${d.tentativas}</dd>
</dl>
<h2>Estimativa de uso</h2>
${blocoEstimativaDetalhe(d.estimativaUso)}
<h2>Custo real</h2>
${blocoCustoReal(a.custo, d.estimativaUso)}
<h2>Descrição</h2><p class="texto">${d.descricao || '—'}</p>
${d.referencias ? html`<h2>Referências</h2><p class="texto">${d.referencias}</p>` : ''}
${
  aguardando
    ? html`<h2>Responder e recolocar na fila</h2>
<form class="campos" method="post" action="/demandas/${d.id}/responder">
<label>Resposta ou insumo<textarea name="texto" rows="4" required maxlength="4000"></textarea></label>
<div><button class="botao" type="submit">Enviar e recolocar na fila</button></div>
</form>`
    : ''
}
<h2>O que os agentes fizeram</h2>
${linhas.length ? html`<ol class="linha-do-tempo">${linhas}</ol>` : html`<p class="vazio">Nenhuma atividade registrada ainda.</p>`}
<h2>Relatório</h2>
${blocoRelatorio(a.relatorio)}`;
}

// metadata já passou pelo schema por tipo de evento (METADATA_SCHEMAS em src/db/eventos.ts) antes de ser
// gravada: só ids, enums, contagens, percentuais e flags chegam aqui, nunca texto livre. Por isso é seguro
// exibir como está — sem risco de vazar raciocínio interno, prompt ou segredo.
function metadataResumida(m: Record<string, unknown>): string {
  const pares = Object.entries(m).map(([chave, valor]) => `${chave}: ${JSON.stringify(valor)}`);
  return pares.length ? pares.join(' · ') : '—';
}

function linhaDoTempoDeEventos(eventos: readonly Evento[]): Bruto {
  if (!eventos.length) return html`<p class="vazio">Nenhum evento registrado ainda.</p>`;
  const linhas = eventos.map(
    (e) => html`<li><time datetime="${e.ocorridoEm}">${formatarData(e.ocorridoEm)}</time>
<span class="agente">${e.resumo}</span>
<div class="texto"><code>${e.tipoEvento}</code> · ator: ${e.ator} · tentativa: ${e.tentativa ?? '—'} · ${metadataResumida(e.metadata)}</div></li>`,
  );
  return html`<ol class="linha-do-tempo">${linhas}</ol>`;
}

// Mensagens não têm schema: m.texto é texto livre (checkpoints operacionais, respostas do solicitante,
// e alguns deles ecoam campos gerados pelo modelo, como "Plano: ${exec.plano}" ou o motivo de uma
// pendência). Diferente de agent_events, nada aqui garante ausência de segredo ou raciocínio interno.
// Por isso o dossiê mostra só metadado estrutural de cada mensagem — nunca m.texto.
function linhaDoTempoDeMensagens(mensagens: readonly Mensagem[]): Bruto {
  if (!mensagens.length) return html`<p class="vazio">Nenhuma mensagem registrada ainda.</p>`;
  const linhas = mensagens.map(
    (m) => html`<li><time datetime="${m.criadoEm}">${formatarData(m.criadoEm)}</time>
<span class="${m.autor === 'solicitante' ? 'solicitante' : 'agente'}">${m.autor === 'solicitante' ? 'Solicitante' : (m.agente ?? 'orquestrador')}</span></li>`,
  );
  return html`<ol class="linha-do-tempo">${linhas}</ol>`;
}

// Só os campos numéricos/estruturados do relatório — nunca ganhos, perdas, aprendizado, ponderações,
// acoesRealizadas (que embute exec.resumo) ou fontesUtilizadas: todos são texto livre gerado pelo modelo,
// sem o mesmo schema de validação que protege agent_events, e podem carregar raciocínio interno ou segredo
// colado pelo usuário. gerente e tempoTotal são construídos pelo próprio código (nunca texto do modelo).
function blocoRelatorioSeguro(r: Relatorio | null): Bruto {
  if (!r) return html`<p class="vazio">Ainda não há relatório para esta demanda.</p>`;
  const m = r.metricas;
  return html`<dl class="info">
<dt>Executado por</dt><dd>${r.gerente}</dd>
<dt>Complexidade</dt><dd>nível ${r.nivelComplexidade}</dd>
<dt>Setores</dt><dd>${r.setoresEnvolvidos.join(', ') || '—'}</dd>
<dt>Índice geral</dt><dd>${numero(m.indiceGeral)}</dd>
<dt>Antipadrões auditados</dt><dd>${numero(m.antipadroesCount)}</dd>
<dt>Regras cumpridas</dt><dd>${numero(m.regrasCumpridasPercent, '%')}</dd>
<dt>Tempo</dt><dd>${m.tempoTotal}</dd>
</dl>
${m.auditoriaFalhou ? html`<p class="aviso">A auditoria automática não terminou: os números de conformidade não foram calculados.</p>` : ''}
<p class="vazio">Ganhos, perdas, aprendizado e demais textos livres do relatório ficam só em /demandas/${r.demandaId} — o dossiê não os exibe, porque são texto do modelo sem o mesmo schema de validação de agent_events.</p>`;
}

export function paginaDossie(a: {
  demanda: Demanda;
  mensagens: readonly Mensagem[];
  relatorio: Relatorio | null;
  eventos: readonly Evento[];
  artefatos: readonly ArtefatoEntregavelResumo[];
  linkEntrega: LinkEntrega | null;
}): Bruto {
  const d = a.demanda;
  return html`<div class="cabecalho">
<div><h1>Dossiê — ${d.titulo}</h1><div class="meta">${chip(d.status)}<span>${d.categoria} — ${SETORES[d.categoria].nome}</span><span>${d.prioridade}</span></div></div>
</div>
${a.linkEntrega ? html`<p>${linkDeEntrega(a.linkEntrega, 'botao')}</p>` : ''}
<h2>Artefatos entregáveis</h2>
${blocoArtefatos(a.artefatos)}
<h2>Resumo executivo</h2>
<dl class="info">
<dt>Solicitante</dt><dd>${d.solicitante ?? '—'}</dd>
<dt>Prazo</dt><dd>${d.prazo ?? '—'}</dd>
<dt>Criada em</dt><dd>${formatarData(d.criadoEm)}</dd>
<dt>Tentativas</dt><dd>${d.tentativas}</dd>
<dt>Status</dt><dd>${d.status}</dd>
</dl>
<h2>Linha do tempo de eventos (agent_events, ordenados por id)</h2>
${linhaDoTempoDeEventos(a.eventos)}
<h2>Mensagens operacionais</h2>
<p class="vazio">Só data e autor — o texto de cada mensagem fica em /demandas/${d.id}, porque pode conter texto livre sem o mesmo schema de validação de agent_events.</p>
${linhaDoTempoDeMensagens(a.mensagens)}
<h2>Relatório</h2>
${blocoRelatorioSeguro(a.relatorio)}
<p><a href="/demandas/${d.id}">Voltar para a demanda</a></p>`;
}

export function paginaRelatorios(a: { relatorios: readonly Relatorio[]; links: ReadonlyMap<string, LinkEntrega | null> }): Bruto {
  const cartoes = a.relatorios.map(
    (r) => html`<li class="card">
<h3><a href="/demandas/${r.demandaId}">${r.demandaTitulo}</a></h3>
<div class="meta"><span>nível ${r.nivelComplexidade}</span><span>índice ${numero(r.metricas.indiceGeral)}</span><span>antipadrões ${numero(r.metricas.antipadroesCount)}</span><span>${formatarData(r.criadoEm)}</span>${linkDeEntrega(a.links.get(r.id))}</div>
</li>`,
  );
  return html`<h1>Relatórios</h1>
${cartoes.length ? html`<ul class="lista">${cartoes}</ul>` : html`<p class="vazio">Nenhum relatório ainda.</p>`}`;
}

export function paginaMensagem(titulo: string, texto: string): Bruto {
  return html`<h1>${titulo}</h1><p>${texto}</p><p><a href="/">Voltar para a fila</a></p>`;
}
