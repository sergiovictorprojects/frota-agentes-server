export const CSS = `
:root{--bg:#faf9f7;--surface:#fff;--border:#e4e0ee;--text:#1c1a24;--dim:#5b5668;--accent:#6D4BC4;--accent-soft:#efe9fb;--ok:#1f8a5f;--warn:#b8790f;--bad:#c0392b}
@media (prefers-color-scheme:dark){:root{--bg:#141219;--surface:#1c1a24;--border:#332e42;--text:#f1eef8;--dim:#a79fc2;--accent:#B49AEE;--accent-soft:#2a2440;--ok:#4fd399;--warn:#f0b73b;--bad:#f0685f}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:var(--accent)}
h1{font-size:1.5rem;margin:0 0 .25rem}
h2{font-size:1.1rem;margin:1.75rem 0 .5rem}
main{max-width:56rem;margin:0 auto;padding:1.25rem 1rem 4rem}
.topo{display:flex;flex-wrap:wrap;gap:.5rem 1.5rem;align-items:center;justify-content:space-between;padding:.75rem 1rem;background:var(--surface);border-bottom:1px solid var(--border)}
.topo nav{display:flex;gap:1rem;flex-wrap:wrap}
.topo nav a{text-decoration:none;color:var(--dim);padding:.25rem 0;border-bottom:2px solid transparent}
.topo nav a[aria-current]{color:var(--text);border-color:var(--accent)}
.estado{font-size:.85rem;color:var(--dim)}
.aviso{background:var(--accent-soft);border:1px solid var(--border);border-radius:8px;padding:.6rem .9rem;margin:0 0 1rem}
.erros{background:transparent;border:1px solid var(--bad);color:var(--bad);border-radius:8px;padding:.6rem .9rem;margin:0 0 1rem}
.cabecalho{display:flex;flex-wrap:wrap;gap:.75rem 1rem;align-items:flex-start;justify-content:space-between;margin-bottom:1rem}
.acoes{display:flex;gap:.5rem;flex-wrap:wrap}
.acoes form{margin:0}
.botao{font:inherit;border:1px solid var(--accent);background:var(--accent);color:#fff;border-radius:8px;padding:.45rem .9rem;cursor:pointer}
.botao.sec{background:transparent;color:var(--accent)}
.botao:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.filtros{display:flex;gap:.4rem;flex-wrap:wrap;margin-bottom:1rem}
.filtro{text-decoration:none;color:var(--dim);border:1px solid var(--border);border-radius:999px;padding:.15rem .7rem;font-size:.85rem}
.filtro.ativo{color:var(--text);border-color:var(--accent);background:var(--accent-soft)}
.lista{list-style:none;margin:0;padding:0;display:grid;gap:.6rem}
.card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:.8rem 1rem}
.card h3{margin:0 0 .3rem;font-size:1rem}
.meta{color:var(--dim);font-size:.85rem;display:flex;gap:.4rem 1rem;flex-wrap:wrap}
.chip{display:inline-block;border-radius:999px;padding:.05rem .6rem;font-size:.78rem;border:1px solid var(--border)}
.chip.ok{color:var(--ok);border-color:var(--ok)}
.chip.erro{color:var(--bad);border-color:var(--bad)}
.chip.espera{color:var(--warn);border-color:var(--warn)}
.chip.andamento{color:var(--accent);border-color:var(--accent)}
.chip.nova,.chip.arquivada{color:var(--dim)}
form.campos{display:grid;gap:.9rem;max-width:40rem}
label{display:grid;gap:.25rem;font-weight:600;font-size:.9rem}
input,select,textarea{font:inherit;color:var(--text);background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:.5rem .6rem;width:100%}
dl.info{display:grid;grid-template-columns:max-content 1fr;gap:.25rem 1rem;margin:0}
dl.info dt{color:var(--dim)}
dl.info dd{margin:0}
.linha-do-tempo{list-style:none;margin:0;padding:0;border-left:2px solid var(--border)}
.linha-do-tempo li{padding:.3rem 0 .6rem 1rem}
.linha-do-tempo time{color:var(--dim);font-size:.8rem}
.agente{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.78rem;color:var(--accent)}
.solicitante{font-weight:600}
.texto{white-space:pre-wrap;overflow-wrap:anywhere}
.vazio{color:var(--dim)}
body.moldura{height:100vh;display:flex;flex-direction:column}
.aviso-entrega{margin:0;padding:.5rem 1rem;background:var(--accent-soft);border-bottom:1px solid var(--border);font-size:.85rem}
.entrega{flex:1;width:100%;border:0;background:#fff}
`;
