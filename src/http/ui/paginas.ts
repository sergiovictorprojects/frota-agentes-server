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
const pct = (valor: number, total: number): string => (total === 0 ? '0' : Math.round((valor / total) * 100).toString());
const pctUso = (valor: number, total: number): number => (total <= 0 ? (valor > 0 ? 100 : 0) : Math.min(100, Math.round((valor / total) * 100)));

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

function painel(titulo: string, conteudo: Bruto, apoio = ''): Bruto {
  return html`<section class="painel">
<div class="secao-titulo"><h2>${titulo}</h2>${apoio ? html`<p>${apoio}</p>` : ''}</div>
${conteudo}
</section>`;
}

function metrica(rotulo: string, valor: string | number | Bruto, detalhe = ''): Bruto {
  return html`<div class="metrica"><span>${rotulo}</span><strong>${valor}</strong>${detalhe ? html`<small>${detalhe}</small>` : ''}</div>`;
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

function resumoUsoApi(custo: ResumoCustoDemanda, estimativa: EstimativaUsoDemanda): {
  custoEstimado: number;
  custoReal: number;
  percentual: number;
  classe: 'ok' | 'alerta' | 'neutro';
  texto: string;
} {
  const custoEstimado = Number(estimativa.custoEstimadoUsd);
  const custoReal = Number(custo.custoUsd);
  const diferenca = custoReal - custoEstimado;
  if (custo.chamadas === 0) {
    return {
      custoEstimado,
      custoReal,
      percentual: 0,
      classe: 'neutro',
      texto: 'Sem consumo real registrado pela API.',
    };
  }
  return {
    custoEstimado,
    custoReal,
    percentual: pctUso(custoReal, custoEstimado),
    classe: diferenca <= 0 ? 'ok' : 'alerta',
    texto: diferenca <= 0 ? `Dentro da estimativa, com ${usd(Math.abs(diferenca).toFixed(6))} de margem.` : `Acima da estimativa em ${usd(diferenca.toFixed(6))}.`,
  };
}

function linhasCustoPorPapel(custo: ResumoCustoDemanda): Bruto {
  if (!custo.porPapel.length) return html`<p class="vazio">Sem detalhamento por agente ainda.</p>`;
  return html`<table class="tabela-custo">
<thead><tr><th>Responsável técnico</th><th>Chamadas</th><th>Tokens</th><th>Custo</th><th>Duração média</th></tr></thead>
<tbody>${custo.porPapel.map(
    (p) => html`<tr>
<td><code>${p.papel}</code></td>
<td>${p.chamadas}</td>
<td>${tokens(p.tokensTotal)}</td>
<td>${usd(p.custoUsd)}</td>
<td>${p.duracaoMediaMs === null ? '—' : `${p.duracaoMediaMs} ms`}</td>
</tr>`,
  )}</tbody>
</table>`;
}

function indicadorRetorno(rotulo: string, valor: string | number | Bruto, detalhe = ''): Bruto {
  return html`<div class="indicador-retorno"><span>${rotulo}</span><strong>${valor}</strong>${detalhe ? html`<small>${detalhe}</small>` : ''}</div>`;
}

function blocoUsoApi(custo: ResumoCustoDemanda, estimativa: EstimativaUsoDemanda): Bruto {
  const uso = resumoUsoApi(custo, estimativa);
  return html`<div class="uso-api ${uso.classe}">
<div class="uso-api-topo"><span>Uso da API</span><strong>${usd(custo.custoUsd)} / ${usd(estimativa.custoEstimadoUsd)}</strong></div>
<div class="uso-barra" aria-label="Percentual do custo estimado utilizado"><span style="width:${uso.percentual}%"></span></div>
<small>${uso.texto}</small>
</div>`;
}

function blocoRelatorioPrestacao(r: Relatorio | null, demanda: Demanda, custo: ResumoCustoDemanda, linkEntrega: LinkEntrega | null): Bruto {
  if (!r) {
    return html`<div class="prestacao vazio-prestacao">
<div class="prestacao-head"><div><p class="kicker">Prestação de contas</p><h3>Relatório ainda não emitido</h3></div><span class="selo-retorno">em aberto</span></div>
<p class="vazio">Quando a demanda for concluída, este espaço vira o retorno oficial do responsável: resultado, uso da API, entrega, aprendizados e próximos cuidados.</p>
${blocoUsoApi(custo, demanda.estimativaUso)}
</div>`;
  }
  const m = r.metricas;
  return html`<div class="prestacao">
<div class="prestacao-head">
<div><p class="kicker">Prestação de contas</p><h3>Retorno do responsável</h3><p class="resumo-humano">Eu conduzi esta demanda até o encerramento e deixo abaixo o saldo da execução: qualidade, custo consumido, entrega e pontos de aprendizado.</p></div>
<span class="selo-retorno">finalizado</span>
</div>
<div class="indicadores-retorno">
${indicadorRetorno('Responsável', r.gerente, `nível ${r.nivelComplexidade}`)}
${indicadorRetorno('Índice geral', numero(m.indiceGeral), m.auditoriaFalhou ? 'auditoria incompleta' : 'qualidade auditada')}
${indicadorRetorno('Custo API', `${usd(custo.custoUsd)}`, `${usd(demanda.estimativaUso.custoEstimadoUsd)} estimado`)}
${indicadorRetorno('Tokens', tokens(custo.tokensTotal), `${custo.chamadas} chamada(s)`)}
</div>
${blocoUsoApi(custo, demanda.estimativaUso)}
<div class="meta">${linkDeEntrega(linkEntrega)}<span>criado em ${formatarData(r.criadoEm)}</span><span>setores ${r.setoresEnvolvidos.join(', ') || '—'}</span></div>
${m.auditoriaFalhou ? html`<p class="aviso">A auditoria automática não terminou: os números de conformidade não foram calculados.</p>` : ''}
<details class="relatorio-detalhado">
<summary>Ver prestação detalhada</summary>
<div class="grade-detalhes">
<dl class="info">
<dt>Regras cumpridas</dt><dd>${numero(m.regrasCumpridasPercent, '%')}</dd>
<dt>Antipadrões auditados</dt><dd>${numero(m.antipadroesCount)}</dd>
<dt>Tempo</dt><dd>${m.tempoTotal}</dd>
<dt>Ações</dt><dd>${m.acoesRealizadas}</dd>
</dl>
<dl class="info">
<dt>Orçamento sugerido</dt><dd>${usd(demanda.estimativaUso.orcamentoSugeridoUsd)}</dd>
<dt>Custo estimado</dt><dd>${usd(demanda.estimativaUso.custoEstimadoUsd)}</dd>
<dt>Custo utilizado</dt><dd>${usd(custo.custoUsd)}</dd>
<dt>Chamadas planejadas</dt><dd>${demanda.estimativaUso.chamadasLlmMin}–${demanda.estimativaUso.chamadasLlmMax}</dd>
</dl>
</div>
${linhasCustoPorPapel(custo)}
<h2>Ganhos</h2><p class="texto">${r.ganhos}</p>
<h2>Perdas</h2><p class="texto">${r.perdas}</p>
<h2>Aprendizado</h2><p class="texto">${r.aprendizado}</p>
${r.ponderacoes.length ? html`<h2>Ponderações</h2><ul>${r.ponderacoes.map((p) => html`<li><strong>${p.setor}</strong>: ${p.nota}</li>`)}</ul>` : ''}
</details>
</div>`;
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
  const total = Object.values(a.contagem).reduce((s, n) => s + (n ?? 0), 0);
  const ativas = (a.contagem.Nova ?? 0) + (a.contagem['Em andamento'] ?? 0) + (a.contagem['Aguardando humano'] ?? 0) + (a.contagem['Aguardando insumo'] ?? 0);
  const concluidas = a.contagem['Concluída'] ?? 0;
  const falhas = a.contagem['Falhou'] ?? 0;
  const filtros = [null, ...STATUS].map((s) => {
    const href = s ? `/?status=${encodeURIComponent(s)}` : '/';
    const total = s ? a.contagem[s] : null;
    return html`<a class="filtro${s === a.filtro ? ' ativo' : ''}" href="${href}">${s ?? 'Todas'}${total ? html` <span>${total}</span>` : ''}</a>`;
  });
  const cartoes = a.demandas.map((d) => {
    const progresso = d.status === 'Concluída' ? 100 : d.status === 'Falhou' ? 100 : d.status === 'Nova' ? 15 : d.status === 'Em andamento' ? 55 : 75;
    return html`<li class="card demanda-card">
<div class="card-head"><div><h3><a href="/demandas/${d.id}">${d.titulo}</a></h3><div class="meta">${chip(d.status)}<span>${d.categoria} — ${SETORES[d.categoria].nome}</span><span>${d.prioridade}</span></div></div><strong>${usd(d.estimativaUso.orcamentoSugeridoUsd)}</strong></div>
<div class="barra"><span style="width:${progresso}%"></span></div>
<div class="meta"><span>${ROTULOS_COMPLEXIDADE_DEMANDA[d.complexidade]}</span><span>${d.estimativaUso.chamadasLlmMin}–${d.estimativaUso.chamadasLlmMax} chamadas</span><span>${formatarData(d.criadoEm)}</span>${linkDeEntrega(a.links.get(d.id))}</div>
</li>`;
  });
  return html`<section class="hero">
<div><p class="kicker">Centro operacional</p><h1>Demandas</h1><p>Acompanhe criação, execução, custo, entrega, relatório e dossiê num único lugar.</p></div>
<div class="acoes">
<a class="botao" href="/demandas/nova">Nova demanda</a>
${a.podeExecutar ? botaoAcao('/executar', 'Executar agora') : ''}
${a.pausado ? botaoAcao('/frota/retomar', 'Retomar frota') : botaoAcao('/frota/pausar', 'Pausar frota', true)}
</div>
</section>
<section class="metricas">
${metrica('Total', total, 'demandas registradas')}
${metrica('Ativas', ativas, `${pct(ativas, total)}% em fila ou execução`)}
${metrica('Concluídas', concluidas, `${pct(concluidas, total)}% encerradas`)}
${metrica('Falhas', falhas, falhas ? 'pedem revisão' : 'nenhuma pendência crítica')}
</section>
<section class="painel">
<div class="secao-titulo"><h2>Fila de demandas</h2><p>Visão de trabalho por status, complexidade, custo estimado e entrega.</p></div>
<nav class="filtros" aria-label="Filtrar por status">${filtros}</nav>
${cartoes.length ? html`<ul class="lista">${cartoes}</ul>` : html`<p class="vazio">Nenhuma demanda aqui ainda. Crie a primeira demanda para iniciar a operação.</p>`}
</section>
<section class="atalhos">
<a class="atalho" href="/relatorios"><strong>Relatórios</strong><span>Aprendizado, métricas e auditorias das demandas concluídas.</span></a>
<a class="atalho" href="/demandas/nova"><strong>Nova demanda</strong><span>Registrar escopo, critérios, complexidade e orçamento sugerido.</span></a>
</section>`;
}

export function paginaNova(a: { valores: Readonly<Record<string, string>>; erros: readonly string[] }): Bruto {
  const v = (campo: string): string => a.valores[campo] ?? '';
  const opcao = (valor: string, rotulo: string, atual: string): Bruto =>
    html`<option value="${valor}"${valor === atual ? bruto(' selected') : ''}>${rotulo}</option>`;
  return html`<section class="hero compacto">
<div><p class="kicker">Entrada de trabalho</p><h1>Nova demanda</h1><p>Registre o pedido com critérios claros para reduzir retrabalho e consumo de API.</p></div>
</section>
${a.erros.length ? html`<ul class="erros" role="alert">${a.erros.map((e) => html`<li>${e}</li>`)}</ul>` : ''}
<section class="painel">
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
</section>
${blocoEstimativasCriacao()}`;
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
  return html`<section class="hero detalhe">
<div><p class="kicker">Demanda</p><h1>${d.titulo}</h1><div class="meta">${chip(d.status)}<span>${d.categoria} — ${SETORES[d.categoria].nome}</span><span>${d.prioridade}</span><span>${ROTULOS_RESULTADO_ESPERADO[d.resultadoEsperado]}</span></div></div>
<div class="acoes">
<a class="botao sec" href="/">Voltar</a>
<a class="botao sec" href="/demandas/${d.id}/dossie">Dossiê</a>
${d.status === 'Falhou' ? botaoAcao(`/demandas/${d.id}/reabrir`, 'Tentar novamente') : ''}
${d.status !== 'Arquivada' && d.status !== 'Em andamento' ? botaoAcao(`/demandas/${d.id}/arquivar`, 'Arquivar', true) : ''}
${d.status !== 'Em andamento' ? botaoExclusao(`/demandas/${d.id}/excluir`) : ''}
</div>
</section>
${a.linkEntrega ? html`<p>${linkDeEntrega(a.linkEntrega, 'botao')}</p>` : ''}
<section class="metricas">
${metrica('Orçamento', usd(d.estimativaUso.orcamentoSugeridoUsd), ROTULOS_COMPLEXIDADE_DEMANDA[d.complexidade])}
${metrica('Custo real', usd(a.custo.custoUsd), `${a.custo.chamadas} chamada(s)`)}
${metrica('Tentativas', d.tentativas, d.status)}
${metrica('Tokens', tokens(a.custo.tokensTotal), a.custo.chamadas ? 'consumo real' : 'sem consumo')}
</section>
<section class="grid-operacional">
<div class="painel destaque">
<div class="secao-titulo"><h2>Diagnóstico operacional</h2><p>Leitura rápida para decidir se retoma, espera ou revisa a demanda.</p></div>
${blocoDiagnosticoOperacional(a.eventos, a.custo)}
</div>
<div class="painel">
<div class="secao-titulo"><h2>Resumo</h2><p>Escopo e aceite que orientam a execução.</p></div>
<dl class="info compacto">
<dt>Solicitante</dt><dd>${d.solicitante ?? '—'}</dd>
<dt>Prazo</dt><dd>${d.prazo ?? '—'}</dd>
<dt>Criada em</dt><dd>${formatarData(d.criadoEm)}</dd>
<dt>Critérios</dt><dd>${d.criteriosAceite || '—'}</dd>
</dl>
</div>
</section>
${painel('Arquivos entregáveis', blocoArtefatos(a.artefatos), 'Downloads finais e artefatos gerados pela frota.')}
<p class="link-discreto"><a href="/demandas/${d.id}/dossie">Abrir dossiê completo</a></p>
<section class="grid-operacional">
<div class="painel">
<div class="secao-titulo"><h2>Estimativa de uso</h2><p>Previsão determinística registrada na criação.</p></div>
${blocoEstimativaDetalhe(d.estimativaUso)}
</div>
<div class="painel">
<div class="secao-titulo"><h2>Custo real</h2><p>Chamadas liquidadas e tokens consumidos.</p></div>
${blocoCustoReal(a.custo, d.estimativaUso)}
</div>
</section>
<section class="painel">
<div class="secao-titulo"><h2>Descrição</h2><p>Pedido original e referências.</p></div>
<p class="texto">${d.descricao || '—'}</p>
${d.referencias ? html`<h3>Referências</h3><p class="texto">${d.referencias}</p>` : ''}
</section>
${
  aguardando
    ? html`<section class="painel">
<div class="secao-titulo"><h2>Responder</h2><p>Envie o insumo e recoloque a demanda na fila.</p></div>
<form class="campos" method="post" action="/demandas/${d.id}/responder">
<label>Resposta ou insumo<textarea name="texto" rows="4" required maxlength="4000"></textarea></label>
<div><button class="botao" type="submit">Enviar e recolocar na fila</button></div>
</form>
</section>`
    : ''
}
<section class="grid-operacional">
<div class="painel">
<div class="secao-titulo"><h2>Atividade</h2><p>Mensagens e checkpoints operacionais.</p></div>
${linhas.length ? html`<ol class="linha-do-tempo">${linhas}</ol>` : html`<p class="vazio">Nenhuma atividade registrada ainda.</p>`}
</div>
<div class="painel">
<div class="secao-titulo"><h2>Relatório</h2><p>Resultado final quando a demanda for concluída.</p></div>
${blocoRelatorioPrestacao(a.relatorio, d, a.custo, a.linkEntrega)}
</div>
</section>`;
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
  return html`<section class="hero detalhe">
<div><p class="kicker">Dossiê auditável</p><h1>${d.titulo}</h1><div class="meta">${chip(d.status)}<span>${d.categoria} — ${SETORES[d.categoria].nome}</span><span>${d.prioridade}</span></div></div>
<div class="acoes"><a class="botao sec" href="/demandas/${d.id}">Voltar para demanda</a></div>
</section>
${a.linkEntrega ? html`<p>${linkDeEntrega(a.linkEntrega, 'botao')}</p>` : ''}
<section class="metricas">
${metrica('Eventos', a.eventos.length, 'agent_events')}
${metrica('Mensagens', a.mensagens.length, 'metadados seguros')}
${metrica('Artefatos', a.artefatos.length, 'arquivos finais')}
${metrica('Tentativas', d.tentativas, d.status)}
</section>
<section class="grid-operacional">
<div class="painel">
<div class="secao-titulo"><h2>Resumo executivo</h2><p>Campos estruturais da demanda e estado atual.</p></div>
<dl class="info compacto">
<dt>Solicitante</dt><dd>${d.solicitante ?? '—'}</dd>
<dt>Prazo</dt><dd>${d.prazo ?? '—'}</dd>
<dt>Criada em</dt><dd>${formatarData(d.criadoEm)}</dd>
<dt>Tentativas</dt><dd>${d.tentativas}</dd>
<dt>Status</dt><dd>${d.status}</dd>
</dl>
</div>
<div class="painel">
<div class="secao-titulo"><h2>Artefatos</h2><p>Entregáveis vinculados a esta demanda.</p></div>
${blocoArtefatos(a.artefatos)}
</div>
</section>
<section class="painel">
<div class="secao-titulo"><h2>Linha do tempo de eventos</h2><p>Eventos ordenados pelo ledger, com metadata validada.</p></div>
${linhaDoTempoDeEventos(a.eventos)}
</section>
<section class="grid-operacional">
<div class="painel">
<div class="secao-titulo"><h2>Mensagens operacionais</h2><p>Somente metadados para evitar expor texto livre sem schema.</p></div>
<p class="vazio">Só data e autor — o texto de cada mensagem fica em /demandas/${d.id}, porque pode conter texto livre sem o mesmo schema de validação de agent_events.</p>
${linhaDoTempoDeMensagens(a.mensagens)}
</div>
<div class="painel">
<div class="secao-titulo"><h2>Relatório seguro</h2><p>Métricas estruturadas do encerramento.</p></div>
${blocoRelatorioSeguro(a.relatorio)}
</div>
</section>`;
}

function cartaoRelatorioPrestacao(
  r: Relatorio,
  demanda: Demanda | undefined,
  custo: ResumoCustoDemanda | undefined,
  link: LinkEntrega | null | undefined,
): Bruto {
  const c = custo ?? { chamadas: 0, tokensEntrada: 0, tokensSaida: 0, tokensCacheRead: 0, tokensCacheWrite: 0, tokensTotal: 0, custoUsd: '0.000000', porPapel: [] };
  const estimativa = demanda?.estimativaUso ?? {
    complexidade: 'MEDIUM' as const,
    modoExecucao: 'controlado',
    chamadasLlmMin: 0,
    chamadasLlmMax: 0,
    tokensEntradaEstimados: 0,
    tokensSaidaEstimados: 0,
    tokensTotaisEstimados: 0,
    custoEstimadoUsd: '0.000000',
    orcamentoSugeridoUsd: '0.000000',
    modeloReferencia: 'indisponível',
  };
  const uso = resumoUsoApi(c, estimativa);
  return html`<li class="card relatorio-card prestacao">
<div class="prestacao-head">
<div><h3><a href="/demandas/${r.demandaId}">${r.demandaTitulo}</a></h3><p class="resumo-humano">Prestação emitida por ${r.gerente}: resultado, consumo e aprendizado em um único retorno.</p></div>
<span class="selo-retorno">${numero(r.metricas.indiceGeral)}</span>
</div>
<div class="indicadores-retorno">
${indicadorRetorno('Custo API', usd(c.custoUsd), `${usd(estimativa.custoEstimadoUsd)} estimado`)}
${indicadorRetorno('Uso', `${uso.percentual}%`, uso.texto)}
${indicadorRetorno('Chamadas', c.chamadas, `${tokens(c.tokensTotal)} tokens`)}
${indicadorRetorno('Regras', numero(r.metricas.regrasCumpridasPercent, '%'), `${numero(r.metricas.antipadroesCount)} antipadrões`)}
</div>
${blocoUsoApi(c, estimativa)}
<div class="meta"><span>nível ${r.nivelComplexidade}</span><span>${formatarData(r.criadoEm)}</span>${linkDeEntrega(link)}</div>
<details class="relatorio-detalhado">
<summary>Ver prestação detalhada</summary>
<div class="grade-detalhes">
<dl class="info">
<dt>Responsável</dt><dd>${r.gerente}</dd>
<dt>Setores</dt><dd>${r.setoresEnvolvidos.join(', ') || '—'}</dd>
<dt>Tempo</dt><dd>${r.metricas.tempoTotal}</dd>
<dt>Ações</dt><dd>${r.metricas.acoesRealizadas}</dd>
</dl>
<dl class="info">
<dt>Orçamento sugerido</dt><dd>${usd(estimativa.orcamentoSugeridoUsd)}</dd>
<dt>Custo estimado</dt><dd>${usd(estimativa.custoEstimadoUsd)}</dd>
<dt>Custo utilizado</dt><dd>${usd(c.custoUsd)}</dd>
<dt>Modelo referência</dt><dd>${estimativa.modeloReferencia}</dd>
</dl>
</div>
${linhasCustoPorPapel(c)}
<h2>Ganhos</h2><p class="texto">${r.ganhos}</p>
<h2>Perdas</h2><p class="texto">${r.perdas}</p>
<h2>Aprendizado</h2><p class="texto">${r.aprendizado}</p>
</details>
</li>`;
}

export function paginaRelatorios(a: {
  relatorios: readonly Relatorio[];
  links: ReadonlyMap<string, LinkEntrega | null>;
  demandas: ReadonlyMap<string, Demanda>;
  custos: ReadonlyMap<string, ResumoCustoDemanda>;
}): Bruto {
  const total = a.relatorios.length;
  const comIndice = a.relatorios.filter((r) => r.metricas.indiceGeral !== null);
  const media = comIndice.length
    ? Math.round(comIndice.reduce((s, r) => s + (r.metricas.indiceGeral ?? 0), 0) / comIndice.length)
    : null;
  const antipadroes = a.relatorios.reduce((s, r) => s + (r.metricas.antipadroesCount ?? 0), 0);
  const custoTotal = a.relatorios.reduce((s, r) => s + Number(a.custos.get(r.demandaId)?.custoUsd ?? 0), 0);
  const tokensTotal = a.relatorios.reduce((s, r) => s + (a.custos.get(r.demandaId)?.tokensTotal ?? 0), 0);
  const cartoes = a.relatorios.map((r) => cartaoRelatorioPrestacao(r, a.demandas.get(r.demandaId), a.custos.get(r.demandaId), a.links.get(r.id)));
  return html`<section class="hero compacto">
<div><p class="kicker">Aprendizado da operação</p><h1>Relatórios</h1><p>Auditoria, métricas e aprendizado derivados das demandas concluídas.</p></div>
<div class="acoes"><a class="botao sec" href="/">Voltar para Demandas</a></div>
</section>
<section class="metricas">
${metrica('Relatórios', total, 'encerramentos registrados')}
${metrica('Índice médio', media === null ? '—' : media, 'qualidade consolidada')}
${metrica('Custo API', usd(custoTotal.toFixed(6)), `${tokens(tokensTotal)} tokens utilizados`)}
${metrica('Antipadrões', antipadroes, 'observados no total')}
</section>
<section class="painel">
<div class="secao-titulo"><h2>Histórico</h2><p>Lista de resultados finais com acesso à demanda, entrega e dossiê.</p></div>
${cartoes.length ? html`<ul class="lista">${cartoes}</ul>` : html`<p class="vazio">Nenhum relatório ainda.</p>`}
</section>`;
}

export function paginaMensagem(titulo: string, texto: string): Bruto {
  return html`<section class="painel"><h1>${titulo}</h1><p>${texto}</p><p><a href="/">Voltar para Demandas</a></p></section>`;
}
