import { z } from 'zod';
import { bytesUtf8, FORMATOS_ARTEFATO, ReferenciaSchema } from '../db/artefatos.ts';
import { PRIORIDADES } from '../domain/setores.ts';
import { dadosDoModelo } from '../llm/models.ts';

// Fase 3.2a: serialização canônica de dados não confiáveis e limites do prompt (seção 5.5 do plano e ADR 0007).
// A PR 3.2b usa isto em todo prompt de uma demanda com envelope; as demandas sem envelope continuam, por
// enquanto, com neutralizarTag e os prompts de hoje. As tags não são a fronteira de segurança: as fronteiras
// reais são o modelo sem ferramentas, a validação por Zod e determinística de toda saída, a saída que só cria o
// próprio artefato ou a entrega única, os limites impostos por código e pelo banco, a entrega em sandbox e a
// auditoria separada.

// Limites em bytes UTF-8, medidos depois da serialização.
export const LIMITE_BYTES_USUARIO = 262_144;
export const LIMITE_BYTES_ARTEFATOS = 131_072;
export const MARGEM_BYTES_ENTRADA = 4_096;

const ABRE_DADOS = '<dados formato="json">';
const FECHA_DADOS = '</dados>';

const ESCAPES: Readonly<Record<string, string>> = {
  '<': '\\u003c',
  '>': '\\u003e',
  '&': '\\u0026',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
};

// Recebe um objeto de forma fechada, valida pelo schema (estrito), aplica JSON.stringify e troca <, >, &, U+2028
// e U+2029 por \uXXXX. Esses caracteres só aparecem dentro de strings JSON, então o escape é sempre válido e
// JSON.parse devolve o original. O resultado vai num único par fixo <dados formato="json">…</dados>: nenhum dado
// vira atributo e nenhum dado consegue fechar o bloco.
export function serializarDadosNaoConfiaveis<T>(schema: z.ZodType<T>, valor: T): string {
  const validado = schema.parse(valor);
  const json = JSON.stringify(validado).replace(/[<>&\u2028\u2029]/g, (c) => ESCAPES[c]!);
  return `${ABRE_DADOS}${json}${FECHA_DADOS}`;
}

// Formas fechadas dos dados que entram nos prompts. Nenhum campo é instrução: todos são dados de terceiros.
export const DemandaSerializadaSchema = z.strictObject({
  titulo: z.string(),
  descricao: z.string(),
  referencias: z.string().nullable(),
  solicitante: z.string().nullable(),
  prazo: z.string().nullable(),
  prioridade: z.enum(PRIORIDADES),
});
export type DemandaSerializada = z.infer<typeof DemandaSerializadaSchema>;

export const FalaSerializadaSchema = z.strictObject({ autor: z.enum(['solicitante', 'frota']), texto: z.string() });
export type FalaSerializada = z.infer<typeof FalaSerializadaSchema>;

export const TarefaSerializadaSchema = z.strictObject({ chave: z.string(), objetivo: z.string() });
export type TarefaSerializada = z.infer<typeof TarefaSerializadaSchema>;

// Um artefato de dependência no prompt: integral (com o conteúdo) ou só com o resumo.
export const ArtefatoSerializadoSchema = z.strictObject({
  chave: z.string(),
  formato: z.enum(FORMATOS_ARTEFATO),
  resumo: z.string(),
  referencias: z.array(ReferenciaSchema),
  integral: z.boolean(),
  conteudo: z.string().optional(),
});
export type ArtefatoSerializado = z.infer<typeof ArtefatoSerializadoSchema>;

// Planejamento, fallback e legado_fixo: demanda e conversa.
export const DadosDemandaSchema = z.strictObject({
  demanda: DemandaSerializadaSchema,
  conversa: z.array(FalaSerializadaSchema),
  conversaOmitida: z.number().int().nonnegative(),
});

export const DadosEspecialistaSchema = z.strictObject({
  demanda: DemandaSerializadaSchema,
  conversa: z.array(FalaSerializadaSchema),
  conversaOmitida: z.number().int().nonnegative(),
  tarefa: TarefaSerializadaSchema,
  artefatos: z.array(ArtefatoSerializadoSchema),
});

export const DadosIntegracaoSchema = z.strictObject({
  demanda: DemandaSerializadaSchema,
  conversa: z.array(FalaSerializadaSchema),
  conversaOmitida: z.number().int().nonnegative(),
  tarefas: z.array(TarefaSerializadaSchema),
  artefatos: z.array(ArtefatoSerializadoSchema),
});

// Auditoria: só a entrega e o resumo de quem executou. As regras de conduta vêm de SETORES, no texto do sistema,
// fora do bloco.
export const DadosAuditoriaSchema = z.strictObject({
  resumo: z.string(),
  entrega: z.strictObject({ tipo: z.string(), titulo: z.string(), conteudo: z.string() }).nullable(),
});

export class ModeloSemJanelaError extends Error {
  constructor(modelo: string) {
    super(`Modelo sem janela de contexto cadastrada: ${modelo}.`);
    this.name = 'ModeloSemJanelaError';
  }
}

export interface MedidaEntrada {
  bytesUsuario: number;
  // Sistema + usuário + schema + margem: é o que a reserva usa (reservaUsd em src/llm/reserva.ts).
  bytesEntrada: number;
}

export function medirEntrada(p: { sistema: string; usuario: string; schema: string }): MedidaEntrada {
  const bytesUsuario = bytesUtf8(p.usuario);
  return { bytesUsuario, bytesEntrada: bytesUtf8(p.sistema) + bytesUsuario + bytesUtf8(p.schema) + MARGEM_BYTES_ENTRADA };
}

// A entrada inteira precisa caber no menor de dois limites: 262.144 bytes para o prompt de usuário e a janela de
// contexto do modelo menos max_tokens. Cada token tem pelo menos um byte, então contar bytes garante que entrada
// e saída cabem na janela. Modelo sem janela cadastrada falha antes de qualquer reserva ou envio.
export function cabeNoLimite(modelo: string, maxTokens: number, medida: MedidaEntrada): boolean {
  let janela: number;
  try {
    janela = dadosDoModelo(modelo).janelaTokens;
  } catch {
    throw new ModeloSemJanelaError(modelo);
  }
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0 || maxTokens >= janela) {
    throw new Error(`max_tokens fora do permitido para ${modelo}.`);
  }
  return medida.bytesUsuario <= LIMITE_BYTES_USUARIO && medida.bytesEntrada <= janela - maxTokens;
}

export interface ArtefatoParaPrompt {
  chave: string;
  formato: ArtefatoSerializado['formato'];
  resumo: string;
  conteudo: string;
  referencias: ArtefatoSerializado['referencias'];
}

export interface PedidoDeReducao {
  modelo: string;
  maxTokens: number;
  sistema: string;
  schema: string;
  artefatos: readonly ArtefatoParaPrompt[];
  // Da mais antiga para a mais recente.
  conversa: readonly FalaSerializada[];
  // Monta o prompt de usuário com os artefatos já decididos e a conversa já reduzida. É chamada de novo a cada
  // passo da redução; o prompt que ela devolve é o mesmo que será enviado.
  montarUsuario: (dados: { artefatos: ArtefatoSerializado[]; conversa: FalaSerializada[]; conversaOmitida: number }) => string;
}

export type ResultadoReducao =
  | {
      cabe: true;
      usuario: string;
      medida: MedidaEntrada;
      artefatosIntegrais: number;
      artefatosSoResumo: number;
      conversaOmitida: number;
    }
  | { cabe: false; codigoErro: 'contexto_excedido' };

function bytesDoArtefato(a: ArtefatoSerializado): number {
  return bytesUtf8(serializarDadosNaoConfiaveis(ArtefatoSerializadoSchema, a));
}

// Redução determinística, nunca corte no meio de um texto:
//   1. os artefatos entram integrais do menor para o maior (desempate por chave) enquanto a soma couber em
//      131.072 bytes; os que sobram entram só com o resumo;
//   2. se o prompt ainda não couber, as mensagens mais antigas da conversa saem, uma a uma;
//   3. se ainda não couber, é contexto_excedido.
// Mesmo pedido, mesmo resultado. No prompt, os artefatos ficam sempre em ordem de chave.
export function reduzirParaCaber(p: PedidoDeReducao): ResultadoReducao {
  const ordemDeTamanho = [...p.artefatos].sort((a, b) => {
    const diferenca =
      bytesDoArtefato({ ...a, integral: true }) - bytesDoArtefato({ ...b, integral: true });
    return diferenca !== 0 ? diferenca : a.chave < b.chave ? -1 : a.chave > b.chave ? 1 : 0;
  });
  const integrais = new Set<string>();
  let somaIntegrais = 0;
  for (const a of ordemDeTamanho) {
    const bytes = bytesDoArtefato({ ...a, integral: true });
    if (somaIntegrais + bytes > LIMITE_BYTES_ARTEFATOS) break;
    somaIntegrais += bytes;
    integrais.add(a.chave);
  }
  const artefatos: ArtefatoSerializado[] = [...p.artefatos]
    .sort((a, b) => (a.chave < b.chave ? -1 : a.chave > b.chave ? 1 : 0))
    .map((a) =>
      integrais.has(a.chave)
        ? { chave: a.chave, formato: a.formato, resumo: a.resumo, referencias: a.referencias, integral: true, conteudo: a.conteudo }
        : { chave: a.chave, formato: a.formato, resumo: a.resumo, referencias: a.referencias, integral: false },
    );

  for (let omitidas = 0; omitidas <= p.conversa.length; omitidas++) {
    const conversa = p.conversa.slice(omitidas);
    const usuario = p.montarUsuario({ artefatos, conversa, conversaOmitida: omitidas });
    const medida = medirEntrada({ sistema: p.sistema, usuario, schema: p.schema });
    if (cabeNoLimite(p.modelo, p.maxTokens, medida)) {
      return {
        cabe: true,
        usuario,
        medida,
        artefatosIntegrais: integrais.size,
        artefatosSoResumo: artefatos.length - integrais.size,
        conversaOmitida: omitidas,
      };
    }
  }
  return { cabe: false, codigoErro: 'contexto_excedido' };
}
