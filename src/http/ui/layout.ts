import { bruto, html, type Bruto } from './html.ts';

export interface EstadoFrota {
  pausado: boolean;
  motivo: string | null;
  ultimaRun: { iniciadoEm: string; status: string; demandasProcessadas: number } | null;
}

export type Aba = 'fila' | 'nova' | 'relatorios';

const ABAS: readonly (readonly [Aba, string, string])[] = [
  ['fila', '/', 'Fila'],
  ['nova', '/demandas/nova', 'Nova demanda'],
  ['relatorios', '/relatorios', 'Relatórios'],
];

export function formatarData(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });
}

function resumoEstado(e: EstadoFrota): Bruto {
  const situacao = e.pausado
    ? html`<span class="chip erro">Pausada</span>${e.motivo ? html` ${e.motivo}` : ''}`
    : html`<span class="chip ok">Ativa</span>`;
  const run = e.ultimaRun
    ? html` · Última execução ${formatarData(e.ultimaRun.iniciadoEm)} (${e.ultimaRun.status}, ${e.ultimaRun.demandasProcessadas} demanda(s))`
    : html` · Nenhuma execução ainda`;
  return html`${situacao}${run}`;
}

export function pagina(o: { titulo: string; ativo: Aba | null; estado: EstadoFrota; corpo: Bruto; aviso?: string | null }): string {
  const abas = ABAS.map(
    ([id, href, rotulo]) => html`<a href="${href}"${o.ativo === id ? bruto(' aria-current="page"') : ''}>${rotulo}</a>`,
  );
  return html`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${o.titulo} · Frota</title>
<link rel="stylesheet" href="/app.css">
</head>
<body>
<header class="topo">
<nav aria-label="Principal">${abas}</nav>
<div class="estado">${resumoEstado(o.estado)}</div>
</header>
<main>
${o.aviso ? html`<p class="aviso" role="status">${o.aviso}</p>` : ''}
${o.corpo}
</main>
</body>
</html>
`.valor;
}
