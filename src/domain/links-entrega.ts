// Regras puras sobre links de entrega. Nenhuma função daqui lê configuração ou ambiente: a origem pública
// sempre chega como argumento, já validada no boot (src/config/env.ts). Ver
// docs/adr/0005-links-de-entrega-verificados.md.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Domínios usados em documentação e exemplos (incluindo os subdomínios). Um link gravado com um deles nunca
// foi uma entrega de verdade fora do sistema; PUBLIC_BASE_URL com um deles é erro de configuração.
const DOMINIOS_PLACEHOLDER = [
  'exemplo.com',
  'exemplo.com.br',
  'example.com',
  'example.net',
  'example.org',
  'seudominio.com',
  'seudominio.com.br',
  'meudominio.com',
  'meudominio.com.br',
  'yourdomain.com',
] as const;

// TLDs reservados (RFC 2606 e RFC 6761): nunca resolvem para um site público de verdade.
const TLDS_RESERVADOS = ['example', 'invalid', 'test', 'localhost'] as const;

// Únicos hosts em que http: é aceito, e só para desenvolvimento local. URL.hostname devolve o IPv6 entre colchetes.
const HOSTS_LOCAIS = ['localhost', '127.0.0.1', '[::1]'] as const;

// Único host de artefato externo que o export legado produz (links de artifact do claude.ai).
const HOSTS_EXTERNOS_LEGADOS = ['claude.ai'] as const;

const normalizarHost = (host: string): string => host.toLowerCase().replace(/\.$/, '');

export function hostReservado(host: string): boolean {
  const h = normalizarHost(host);
  if (DOMINIOS_PLACEHOLDER.some((d) => h === d || h.endsWith(`.${d}`))) return true;
  const tld = h.split('.').at(-1) ?? '';
  // "localhost" sozinho é desenvolvimento local; "algo.localhost" é reservado.
  return h !== 'localhost' && (TLDS_RESERVADOS as readonly string[]).includes(tld);
}

export function hostLocal(host: string): boolean {
  return (HOSTS_LOCAIS as readonly string[]).includes(normalizarHost(host));
}

function analisar(url: string): URL | null {
  // Sem base: uma URL protocol-relative ("//host/...") ou relativa falha aqui de propósito.
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

// Regra do boot para PUBLIC_BASE_URL. Devolve o problema (sem citar o valor recebido) ou null.
export function problemaNaOrigemPublica(valor: string): string | null {
  const u = analisar(valor);
  if (!u) return 'deve ser uma URL valida';
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'deve usar https';
  if (u.username || u.password) return 'nao pode conter usuario ou senha';
  if (u.pathname !== '/' || u.search || u.hash) return 'deve ser so a origem, sem caminho, query ou fragmento';
  if (hostLocal(u.hostname)) return null;
  if (u.protocol !== 'https:') return 'deve usar https (http so para localhost, 127.0.0.1 ou [::1])';
  if (hostReservado(u.hostname)) return 'usa um dominio de exemplo ou reservado; configure o dominio publico real';
  return null;
}

// UUID de uma URL que tem forma de entrega interna: caminho exato /entregas/<uuid>, sem query nem fragmento,
// na origem pública configurada ou num host de exemplo (o caso do incidente). Isto é só um candidato: quem
// decide se é mesmo uma entrega interna é o registro em `entregas` (ver src/http/ui/links-entrega.ts).
export function uuidCandidatoInterno(url: string | null, origemPublica: string): string | null {
  const u = url ? analisar(url) : null;
  if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:')) return null;
  if (u.username || u.password || u.search || u.hash) return null;
  if (u.origin !== origemPublica && !hostReservado(u.hostname)) return null;
  const m = /^\/entregas\/([^/]+)$/.exec(u.pathname);
  return m?.[1] && UUID.test(m[1]) ? m[1].toLowerCase() : null;
}

export interface ArtefatoExterno {
  href: string;
  host: string;
}

// Artefato externo importado do sistema antigo: só https e só hosts da allowlist.
export function classificarArtefatoExterno(url: string | null): ArtefatoExterno | null {
  const u = url ? analisar(url) : null;
  if (!u || u.protocol !== 'https:' || u.username || u.password) return null;
  const host = normalizarHost(u.hostname);
  return (HOSTS_EXTERNOS_LEGADOS as readonly string[]).includes(host) ? { href: u.href, host } : null;
}

export type LinkEntrega =
  | { tipo: 'interna'; href: string }
  | { tipo: 'externa_legada'; href: string; host: string }
  | { tipo: 'nao_verificada' };
