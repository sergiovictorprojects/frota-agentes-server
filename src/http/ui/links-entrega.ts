import { listarDonosDeEntregas } from '../../db/relatorios.ts';
import type { Db } from '../../db/tx.ts';
import { classificarArtefatoExterno, uuidCandidatoInterno, type LinkEntrega } from '../../domain/links-entrega.ts';

export interface ItemComEntrega {
  demandaId: string;
  entregaUrl: string | null;
}

// A fonte de verdade de uma entrega interna é a tabela `entregas`, nunca o texto gravado em entrega_url.
// Um link só vira "interna" quando o UUID extraído da URL existe em `entregas` E pertence à mesma demanda
// exibida; o href é montado a partir do id do registro e é sempre relativo, então não depende do host
// gravado nem do header Host da requisição. O resto: artefato externo legado da allowlist, ou "não
// verificada" (texto, sem href). Uma consulta por página, pela chave primária.
export async function resolverLinksDeEntrega(
  db: Db,
  origemPublica: string,
  itens: readonly ItemComEntrega[],
): Promise<(LinkEntrega | null)[]> {
  const candidatos = itens.map((i) => uuidCandidatoInterno(i.entregaUrl, origemPublica));
  const donos = await listarDonosDeEntregas(
    db,
    candidatos.filter((c): c is string => c !== null),
  );
  return itens.map((item, i): LinkEntrega | null => {
    if (!item.entregaUrl) return null;
    const candidato = candidatos[i];
    if (candidato) {
      return donos.get(candidato) === item.demandaId ? { tipo: 'interna', href: `/entregas/${candidato}` } : { tipo: 'nao_verificada' };
    }
    const externo = classificarArtefatoExterno(item.entregaUrl);
    return externo ? { tipo: 'externa_legada', ...externo } : { tipo: 'nao_verificada' };
  });
}
