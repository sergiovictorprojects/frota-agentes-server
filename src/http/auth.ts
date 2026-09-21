import { createHash, timingSafeEqual } from 'node:crypto';

function digest(valor: string): Buffer {
  return createHash('sha256').update(valor).digest();
}

// Compara resumos de tamanho fixo em tempo constante.
function iguais(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

export function credenciaisValidas(cabecalho: string | undefined, usuario: string, senha: string): boolean {
  if (!cabecalho?.startsWith('Basic ')) return false;
  const decodificado = Buffer.from(cabecalho.slice(6), 'base64').toString('utf8');
  const separador = decodificado.indexOf(':');
  if (separador < 0) return false;
  const usuarioOk = iguais(decodificado.slice(0, separador), usuario);
  const senhaOk = iguais(decodificado.slice(separador + 1), senha);
  return usuarioOk && senhaOk;
}

// O navegador reenvia a autenticação Basic sozinho, então um site de terceiros poderia disparar um
// POST em nome do usuário. Navegadores modernos informam a origem; sem essas informações a chamada
// não vem de um navegador (curl, scripts) e não há CSRF a evitar.
export function origemConfiavel(cabecalhos: { origin?: string; secFetchSite?: string; host?: string }): boolean {
  if (cabecalhos.secFetchSite) return cabecalhos.secFetchSite === 'same-origin' || cabecalhos.secFetchSite === 'none';
  if (cabecalhos.origin) {
    try {
      return new URL(cabecalhos.origin).host === cabecalhos.host;
    } catch {
      return false;
    }
  }
  return true;
}
