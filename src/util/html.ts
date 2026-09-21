const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escaparHtml(texto: string): string {
  return texto.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

// Entregas em texto também são hospedadas como página: tudo é escapado, nada vira marcação.
export function paginaDeTexto(titulo: string, texto: string): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escaparHtml(titulo)}</title>
<style>
  body { font: 16px/1.6 system-ui, sans-serif; max-width: 72ch; margin: 2rem auto; padding: 0 1rem; color: #1c1a24; background: #faf9f7; }
  h1 { font-size: 1.4rem; }
  pre { white-space: pre-wrap; word-wrap: break-word; font: inherit; }
  @media (prefers-color-scheme: dark) { body { color: #f1eef8; background: #141219; } }
</style>
</head>
<body>
<h1>${escaparHtml(titulo)}</h1>
<pre>${escaparHtml(texto)}</pre>
</body>
</html>
`;
}
