export type NivelLog = 'info' | 'aviso' | 'erro';

// Uma linha JSON por evento: fácil de filtrar no painel de logs do provedor.
export function log(nivel: NivelLog, tipo: string, dados: Record<string, unknown> = {}): void {
  const linha = JSON.stringify({ ts: new Date().toISOString(), nivel, tipo, ...dados });
  if (nivel === 'erro') console.error(linha);
  else console.log(linha);
}

export function mensagemDeErro(erro: unknown): string {
  if (erro instanceof Error) return erro.message;
  if (typeof erro === 'object' && erro !== null) {
    try {
      return JSON.stringify(erro);
    } catch {
      return Object.prototype.toString.call(erro);
    }
  }
  return String(erro);
}
