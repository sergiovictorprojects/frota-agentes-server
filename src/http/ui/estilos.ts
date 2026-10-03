export const CSS = `
:root{--bg:#f6f3ee;--surface:#fffdf9;--surface-2:#f0ebe2;--border:#ded6c8;--text:#1c1a16;--dim:#676056;--faint:#918878;--accent:#3657d6;--accent-soft:#e8edff;--ok:#0f8a5f;--ok-soft:#ddf5ea;--warn:#a66a00;--warn-soft:#fff2d5;--bad:#b7352d;--bad-soft:#ffe2df;--shadow:0 10px 28px rgba(40,32,20,.08)}
@media (prefers-color-scheme:dark){:root{--bg:#111315;--surface:#191c20;--surface-2:#22262c;--border:#343941;--text:#f3efe7;--dim:#b5ac9d;--faint:#8f887d;--accent:#8ea2ff;--accent-soft:#222943;--ok:#55d79d;--ok-soft:#17372a;--warn:#f1b44c;--warn-soft:#382b15;--bad:#ff746c;--bad-soft:#3d201f;--shadow:none}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 "Public Sans",system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:var(--accent)}
h1{font-size:1.55rem;line-height:1.15;margin:0 0 .35rem;font-weight:750;letter-spacing:0}
h2{font-size:1rem;margin:1.6rem 0 .65rem;text-transform:uppercase;letter-spacing:.08em;color:var(--faint)}
h3{letter-spacing:0}
main{max-width:74rem;margin:0 auto;padding:1.4rem 1rem 4rem}
.topo{display:flex;flex-wrap:wrap;gap:.7rem 1.5rem;align-items:center;justify-content:space-between;padding:.9rem 1rem;background:linear-gradient(180deg,var(--surface),var(--surface-2));border-bottom:1px solid var(--border);box-shadow:var(--shadow)}
.marca{display:grid;line-height:1.1}
.marca strong{font-size:1rem}
.marca span{font-size:.78rem;color:var(--faint)}
.topo nav{display:flex;gap:1rem;flex-wrap:wrap}
.topo nav a{text-decoration:none;color:var(--dim);padding:.25rem 0;border-bottom:2px solid transparent}
.topo nav a[aria-current]{color:var(--text);border-color:var(--accent)}
.estado{font-size:.85rem;color:var(--dim)}
.aviso{background:var(--accent-soft);border:1px solid var(--border);border-radius:8px;padding:.6rem .9rem;margin:0 0 1rem}
.erros{background:transparent;border:1px solid var(--bad);color:var(--bad);border-radius:8px;padding:.6rem .9rem;margin:0 0 1rem}
.hero{display:flex;justify-content:space-between;gap:1rem;align-items:flex-end;border:1px solid var(--border);border-radius:8px;background:linear-gradient(135deg,var(--surface),var(--surface-2));padding:1.15rem 1.2rem;margin-bottom:1rem;box-shadow:var(--shadow)}
.hero.compacto{align-items:center}
.hero.detalhe{align-items:flex-start}
.hero p{margin:.15rem 0 0;color:var(--dim);max-width:48rem}
.kicker{margin:0 0 .25rem;color:var(--accent);font-size:.72rem;font-weight:800;text-transform:uppercase;letter-spacing:.12em}
.metricas{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:.65rem;margin:0 0 1rem}
.metrica{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:.8rem .9rem;box-shadow:var(--shadow)}
.metrica span{display:block;color:var(--faint);font-size:.76rem;text-transform:uppercase;letter-spacing:.08em}
.metrica strong{display:block;font-size:1.35rem;line-height:1.1;margin:.2rem 0}
.metrica small{display:block;color:var(--dim)}
.painel{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:1rem;box-shadow:var(--shadow);margin-bottom:1rem}
.painel.destaque{background:linear-gradient(180deg,var(--surface),var(--accent-soft))}
.secao-titulo{display:flex;justify-content:space-between;gap:1rem;align-items:flex-start;margin-bottom:.8rem}
.secao-titulo h2{margin:0}
.secao-titulo p{margin:0;color:var(--dim);font-size:.9rem;max-width:34rem}
.grid-operacional{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:1rem}
.atalhos{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem}
.atalho{display:block;text-decoration:none;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:1rem;box-shadow:var(--shadow)}
.atalho strong{display:block;color:var(--text);font-size:1rem}
.atalho span{display:block;color:var(--dim);margin-top:.2rem}
.cabecalho{display:flex;flex-wrap:wrap;gap:.75rem 1rem;align-items:flex-start;justify-content:space-between;margin-bottom:1rem}
.acoes{display:flex;gap:.5rem;flex-wrap:wrap}
.acoes form{margin:0}
.botao{font:inherit;font-weight:700;border:1px solid var(--accent);background:var(--accent);color:#fff;border-radius:8px;padding:.48rem .9rem;cursor:pointer;text-decoration:none;display:inline-block}
.botao.sec{background:transparent;color:var(--accent)}
.botao:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.filtros{display:flex;gap:.4rem;flex-wrap:wrap;margin-bottom:1rem}
.filtro{text-decoration:none;color:var(--dim);border:1px solid var(--border);border-radius:999px;padding:.15rem .7rem;font-size:.85rem}
.filtro.ativo{color:var(--text);border-color:var(--accent);background:var(--accent-soft)}
.lista{list-style:none;margin:0;padding:0;display:grid;gap:.6rem}
.card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:.85rem 1rem;box-shadow:var(--shadow)}
.card h3{margin:0 0 .3rem;font-size:1rem}
.card-head{display:flex;justify-content:space-between;gap:1rem;align-items:flex-start;margin-bottom:.5rem}
.card-head strong{white-space:nowrap;color:var(--accent)}
.demanda-card,.relatorio-card{padding:1rem}
.barra{height:7px;border-radius:999px;background:var(--surface-2);overflow:hidden;margin:.75rem 0}
.barra span{display:block;height:100%;background:linear-gradient(90deg,var(--accent),var(--ok));border-radius:inherit}
.meta{color:var(--dim);font-size:.85rem;display:flex;gap:.4rem 1rem;flex-wrap:wrap}
.chip{display:inline-block;border-radius:999px;padding:.08rem .65rem;font-size:.75rem;font-weight:750;border:1px solid var(--border);background:var(--surface-2)}
.chip.ok{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 50%,var(--border));background:var(--ok-soft)}
.chip.erro{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 50%,var(--border));background:var(--bad-soft)}
.chip.espera{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 50%,var(--border));background:var(--warn-soft)}
.chip.andamento{color:var(--accent);border-color:color-mix(in srgb,var(--accent) 50%,var(--border));background:var(--accent-soft)}
.chip.nova,.chip.arquivada{color:var(--dim)}
form.campos{display:grid;gap:.9rem;max-width:40rem}
label{display:grid;gap:.25rem;font-weight:600;font-size:.9rem}
input,select,textarea{font:inherit;color:var(--text);background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:.5rem .6rem;width:100%}
.painel-custo{margin-top:1.25rem;max-width:56rem}
.tabela-custo{width:100%;border-collapse:collapse;background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden}
.tabela-custo th,.tabela-custo td{text-align:left;border-bottom:1px solid var(--border);padding:.5rem .6rem;font-size:.9rem}
.tabela-custo th{color:var(--dim);font-weight:600;background:var(--accent-soft)}
.tabela-custo tr:last-child td{border-bottom:0}
dl.info{display:grid;grid-template-columns:max-content 1fr;gap:.25rem 1rem;margin:0}
dl.info.compacto{grid-template-columns:7rem 1fr}
dl.info dt{color:var(--dim)}
dl.info dd{margin:0}
.diagnostico{display:flex;justify-content:space-between;gap:1rem;align-items:flex-start;border:1px solid var(--border);border-left:5px solid var(--accent);background:var(--surface);border-radius:8px;padding:.85rem 1rem;box-shadow:var(--shadow)}
.diagnostico strong{display:block;font-size:1rem}
.diagnostico span{display:block;color:var(--dim);margin-top:.15rem}
.diagnostico small{display:block;color:var(--faint);margin-top:.45rem}
.diagnostico .medidor{white-space:nowrap;border:1px solid var(--border);border-radius:999px;padding:.12rem .65rem;font-size:.78rem;font-weight:750;color:var(--dim);background:var(--surface-2)}
.diagnostico.ok{border-left-color:var(--ok)}
.diagnostico.retry{border-left-color:var(--warn)}
.diagnostico.acao{border-left-color:var(--bad)}
.linha-do-tempo{list-style:none;margin:0;padding:0;border-left:2px solid var(--border)}
.linha-do-tempo li{padding:.3rem 0 .6rem 1rem}
.linha-do-tempo time{color:var(--dim);font-size:.8rem}
.agente{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.78rem;color:var(--accent)}
.solicitante{font-weight:600}
.texto{white-space:pre-wrap;overflow-wrap:anywhere}
.vazio{color:var(--dim)}
.link-discreto{margin-top:-.35rem}
body.moldura{height:100vh;display:flex;flex-direction:column}
.aviso-entrega{margin:0;padding:.5rem 1rem;background:var(--accent-soft);border-bottom:1px solid var(--border);font-size:.85rem}
.entrega{flex:1;width:100%;border:0;background:#fff}
@media (max-width:800px){
  .hero{align-items:flex-start;flex-direction:column}
  .metricas,.grid-operacional,.atalhos{grid-template-columns:1fr}
  .secao-titulo{display:block}
  .card-head{display:block}
  dl.info,dl.info.compacto{grid-template-columns:1fr}
}
`;
