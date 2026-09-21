import type { Demanda } from '../../db/demandas.ts';
import type { Mensagem } from '../../db/mensagens.ts';
import type { Relatorio } from '../../db/relatorios.ts';
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
const linkSeguro = (url: string | null): string | null => (url && /^https?:\/\//.test(url) ? url : null);
const numero = (n: number | null | undefined, sufixo = ''): string => (n === null || n === undefined ? 'não medido' : `${n}${sufixo}`);

function botaoAcao(acao: string, rotulo: string, secundario = false): Bruto {
  return html`<form method="post" action="${acao}"><button class="botao${secundario ? ' sec' : ''}" type="submit">${rotulo}</button></form>`;
}

export function paginaFila(a: {
  demandas: readonly Demanda[];
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
    const entrega = linkSeguro(d.entregaUrl);
    return html`<li class="card">
<h3><a href="/demandas/${d.id}">${d.titulo}</a> ${chip(d.status)}</h3>
<div class="meta"><span>${d.categoria} — ${SETORES[d.categoria].nome}</span><span>${d.prioridade}</span><span>${formatarData(d.criadoEm)}</span>${entrega ? html`<a href="${entrega}">Abrir entrega</a>` : ''}</div>
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
<label>Prioridade<select name="prioridade">${PRIORIDADES.map((p) => opcao(p, p, v('prioridade') || 'MEDIUM'))}</select></label>
<label>Prazo<input type="date" name="prazo" value="${v('prazo')}"></label>
<label>Solicitante<input name="solicitante" maxlength="200" value="${v('solicitante')}"></label>
<label>Descrição<textarea name="descricao" rows="8" maxlength="20000">${v('descricao')}</textarea></label>
<label>Referências<textarea name="referencias" rows="3" maxlength="5000">${v('referencias')}</textarea></label>
<div><button class="botao" type="submit">Criar demanda</button></div>
</form>`;
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

export function paginaDetalhe(a: { demanda: Demanda; mensagens: readonly Mensagem[]; relatorio: Relatorio | null }): Bruto {
  const d = a.demanda;
  const entrega = linkSeguro(d.entregaUrl);
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
</div>
</div>
${entrega ? html`<p><a class="botao" href="${entrega}">Abrir entrega</a></p>` : ''}
<dl class="info">
<dt>Solicitante</dt><dd>${d.solicitante ?? '—'}</dd>
<dt>Prazo</dt><dd>${d.prazo ?? '—'}</dd>
<dt>Criada em</dt><dd>${formatarData(d.criadoEm)}</dd>
<dt>Tentativas</dt><dd>${d.tentativas}</dd>
</dl>
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

export function paginaRelatorios(a: { relatorios: readonly Relatorio[] }): Bruto {
  const cartoes = a.relatorios.map(
    (r) => html`<li class="card">
<h3><a href="/demandas/${r.demandaId}">${r.demandaTitulo}</a></h3>
<div class="meta"><span>nível ${r.nivelComplexidade}</span><span>índice ${numero(r.metricas.indiceGeral)}</span><span>antipadrões ${numero(r.metricas.antipadroesCount)}</span><span>${formatarData(r.criadoEm)}</span>${linkSeguro(r.entregaUrl) ? html`<a href="${linkSeguro(r.entregaUrl)}">Abrir entrega</a>` : ''}</div>
</li>`,
  );
  return html`<h1>Relatórios</h1>
${cartoes.length ? html`<ul class="lista">${cartoes}</ul>` : html`<p class="vazio">Nenhum relatório ainda.</p>`}`;
}

export function paginaMensagem(titulo: string, texto: string): Bruto {
  return html`<h1>${titulo}</h1><p>${texto}</p><p><a href="/">Voltar para a fila</a></p>`;
}
