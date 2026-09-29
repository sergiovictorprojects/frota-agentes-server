import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  filtrarReferencias,
  inserirArtefato,
  jsonAceitoPeloBanco,
  LIMITE_BYTES_ARTEFATO_ESPECIALISTA,
  LIMITE_BYTES_ARTEFATO_INTEGRACAO,
  LIMITE_REFERENCIAS,
  listarArtefatosDasDependencias,
  PROFUNDIDADE_MAXIMA_JSON,
  ReferenciaSchema,
  sha256Hex,
  urlDeReferenciaValida,
  validarArtefato,
  type ArtefatoProposto,
} from '../../src/db/artefatos.ts';
import { concluirTarefaEspecialista } from '../../src/db/tarefas.ts';
import { comTransacao } from '../../src/db/tx.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';
import { artefatoDeTeste, enviar, planoAtivoDeTeste, reivindicar, reivindicarEEnviar } from '../helpers/execucao.ts';

// Fase 3.2a: o contrato do artefato de uma tarefa (src/db/artefatos.ts) e o que o banco repete (migration 006).

const proposto = (p: Partial<ArtefatoProposto> = {}): ArtefatoProposto => ({
  formato: 'texto',
  resumo: 'Resumo do resultado.',
  conteudo: 'Conteudo do resultado.',
  referencias: [],
  ...p,
});
const semDependencias = new Set<string>();

describe('validarArtefato e filtrarReferencias (sem banco)', () => {
  it('aceita o artefato dentro do contrato e devolve so as referencias validas', () => {
    expect(validarArtefato(proposto(), 'especialista', semDependencias)).toEqual({
      valido: true,
      artefato: { formato: 'texto', resumo: 'Resumo do resultado.', conteudo: 'Conteudo do resultado.', referencias: [] },
      referenciasDescartadas: 0,
    });
    const json = validarArtefato(proposto({ formato: 'json', conteudo: '{"a":[1,2,{"b":null}]}' }), 'integracao', semDependencias);
    expect(json.valido).toBe(true);
  });

  it.each([
    ['resumo vazio', proposto({ resumo: '' }), 'especialista'],
    ['resumo com 501 caracteres', proposto({ resumo: 'x'.repeat(501) }), 'especialista'],
    ['resumo com 501 emojis', proposto({ resumo: '😀'.repeat(501) }), 'especialista'],
    ['resumo com NUL', proposto({ resumo: 'a\u0000b' }), 'especialista'],
    ['conteudo da especialista acima de 65.536 bytes (conta bytes, nao caracteres)', proposto({ conteudo: 'ç'.repeat(32_769) }), 'especialista'],
    ['conteudo da integracao acima de 131.072 bytes', proposto({ conteudo: 'x'.repeat(LIMITE_BYTES_ARTEFATO_INTEGRACAO + 1) }), 'integracao'],
    ['conteudo com substituto UTF-16 solto', proposto({ conteudo: 'a\uD800b' }), 'especialista'],
    ['conteudo com NUL', proposto({ conteudo: 'a\u0000b' }), 'especialista'],
    ['formato json com texto que nao e JSON', proposto({ formato: 'json', conteudo: 'nao e json' }), 'especialista'],
    ['formato json com NUL numa string', proposto({ formato: 'json', conteudo: '{"a":"\\u0000"}' }), 'especialista'],
    ['formato json com substituto solto numa chave', proposto({ formato: 'json', conteudo: '{"\\ud800":1}' }), 'especialista'],
    ['formato json com numero fora da faixa do banco', proposto({ formato: 'json', conteudo: '{"a":1e200000}' }), 'especialista'],
    ['formato json aninhado demais', proposto({ formato: 'json', conteudo: '['.repeat(65) + ']'.repeat(65) }), 'especialista'],
  ] as const)('recusa com artefato_invalido: %s', (_caso, artefato, tipo) => {
    expect(validarArtefato(artefato, tipo, semDependencias)).toEqual({ valido: false, codigoErro: 'artefato_invalido' });
  });

  it('os limites de tamanho valem exatamente no limite', () => {
    expect(validarArtefato(proposto({ resumo: '😀'.repeat(500) }), 'especialista', semDependencias).valido).toBe(true);
    expect(validarArtefato(proposto({ conteudo: 'ç'.repeat(LIMITE_BYTES_ARTEFATO_ESPECIALISTA / 2) }), 'especialista', semDependencias).valido).toBe(true);
    expect(validarArtefato(proposto({ conteudo: 'x'.repeat(LIMITE_BYTES_ARTEFATO_INTEGRACAO) }), 'integracao', semDependencias).valido).toBe(true);
    expect(validarArtefato(proposto({ conteudo: 'x'.repeat(LIMITE_BYTES_ARTEFATO_ESPECIALISTA + 1) }), 'especialista', semDependencias).valido).toBe(false);
  });

  it('filtrarReferencias descarta o que sai do formato fechado ou aponta para fora das dependencias diretas, e corta em 10', () => {
    const dependencia = randomUUID();
    const propostas = [
      { tipo: 'url', url: 'https://example.com/guia' },
      { tipo: 'url', url: 'http://example.com/guia' },
      { tipo: 'fonte', citacao: 'Manual do produto, capitulo 2' },
      { tipo: 'artefato', tarefaId: dependencia },
      { tipo: 'artefato', tarefaId: randomUUID() },
      { tipo: 'fonte', citacao: 'x', extra: true },
      'texto solto',
      null,
    ];
    expect(filtrarReferencias(propostas, new Set([dependencia]))).toEqual({
      referencias: [propostas[0], propostas[2], propostas[3]],
      descartadas: 5,
    });
    const muitas = Array.from({ length: 12 }, (_, i) => ({ tipo: 'fonte', citacao: `Fonte ${i}` }));
    const r = filtrarReferencias(muitas, semDependencias);
    expect(r.referencias).toHaveLength(LIMITE_REFERENCIAS);
    expect(r.descartadas).toBe(2);
    expect(validarArtefato(proposto({ referencias: muitas }), 'especialista', semDependencias)).toMatchObject({ valido: true, referenciasDescartadas: 2 });
  });

  it('sha256Hex e o sha-256 dos bytes UTF-8', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('ção')).not.toBe(sha256Hex('cao'));
  });
});

describe('artefatos_tarefa (migration 006)', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.drop();
  });

  describe('paridade entre o Zod e o banco', () => {
    it('referencia_url_valida decide igual a urlDeReferenciaValida', async () => {
      const urls = [
        'https://example.com',
        'https://example.com/',
        'https://docs.example.com/guia/instalacao',
        'https://sub.example.co.uk/a-b_c.html',
        'https://ex--ample.com/x',
        'https://example.com/%20espaco',
        'https://example.com/2024/09/relatorio-anual',
        'https://example.com/guia-completo-de-postgres',
        `https://example.com/${'a'.repeat(23)}`,
        `https://example.com/${'a'.repeat(24)}`,
        `https://example.com/x_${'a'.repeat(22)}`,
        'https://example.com/abcdefghijklmn1',
        'https://example.com/abcdefghijklmno1',
        'https://example.com/1abcdefghijklmnop',
        `https://example.com/${randomUUID()}`,
        `https://example.com/${randomUUID().toUpperCase()}`,
        `https://example.com${'/abcd'.repeat(96)}`,
        `https://example.com${'/abcd'.repeat(97)}`,
        'http://example.com',
        'HTTPS://example.com',
        'https://Example.com',
        'https://127.0.0.1/x',
        'https://localhost/x',
        'https://a.b',
        'https://exa_mple.com',
        'https://-ruim.com',
        'https://user@example.com',
        'https://user:senha@example.com',
        'https://example.com:8443/',
        'https://example.com/busca?q=1',
        'https://example.com/pagina#secao',
        'https://example.com/a b',
        'https://example.com/<script>',
        'javascript:alert(1)',
        '',
      ];
      for (const url of urls) {
        const { rows } = await db.pool.query<{ ok: boolean }>('SELECT referencia_url_valida($1) AS ok', [url]);
        expect(rows[0]!.ok, url).toBe(urlDeReferenciaValida(url));
      }
      // O conjunto tem casos dos dois lados.
      expect(urls.filter(urlDeReferenciaValida).length).toBeGreaterThan(5);
      expect(urls.filter((u) => !urlDeReferenciaValida(u)).length).toBeGreaterThan(5);
    });

    it('artefato_referencias_validas decide igual ao ReferenciaSchema com o limite de 10', async () => {
      const valida = (r: unknown) => Array.isArray(r) && r.length <= LIMITE_REFERENCIAS && r.every((x) => ReferenciaSchema.safeParse(x).success);
      const uuid = randomUUID();
      const casos: unknown[] = [
        [],
        [{ tipo: 'url', url: 'https://example.com/guia' }],
        [{ tipo: 'url', url: 'http://example.com/guia' }],
        [{ tipo: 'url', url: 5 }],
        [{ tipo: 'url', url: 'https://example.com', extra: 1 }],
        [{ tipo: 'fonte', citacao: 'Livro, p. 10' }],
        [{ tipo: 'fonte', citacao: ' ' }],
        [{ tipo: 'fonte', citacao: '' }],
        [{ tipo: 'fonte', citacao: 'x'.repeat(300) }],
        [{ tipo: 'fonte', citacao: 'x'.repeat(301) }],
        [{ tipo: 'fonte', citacao: '😀'.repeat(300) }],
        [{ tipo: 'fonte', citacao: '😀'.repeat(301) }],
        [{ tipo: 'fonte', citacao: 'linha\nquebrada' }],
        [{ tipo: 'fonte', citacao: 'separador\u2028de linha' }],
        [{ tipo: 'fonte', citacao: 'controle\u0085C1' }],
        [{ tipo: 'artefato', tarefaId: uuid }],
        [{ tipo: 'artefato', tarefaId: uuid.toUpperCase() }],
        [{ tipo: 'artefato', tarefaId: 'nao-e-uuid' }],
        [{ tipo: 'artefato', tarefaId: uuid, extra: 1 }],
        [{ tipo: 'desconhecido' }],
        [{}],
        ['texto solto'],
        [null],
        Array.from({ length: 10 }, () => ({ tipo: 'fonte', citacao: 'x' })),
        Array.from({ length: 11 }, () => ({ tipo: 'fonte', citacao: 'x' })),
        { tipo: 'fonte', citacao: 'objeto, nao array' },
        'texto',
      ];
      for (const caso of casos) {
        const { rows } = await db.pool.query<{ ok: boolean }>('SELECT artefato_referencias_validas($1::jsonb) AS ok', [JSON.stringify(caso)]);
        expect(rows[0]!.ok, JSON.stringify(caso).slice(0, 80)).toBe(valida(caso));
      }
    });

    it('o JSON que jsonAceitoPeloBanco aceita, texto_e_json tambem aceita; e ela nunca lanca', async () => {
      const aninhado = (n: number) => '['.repeat(n) + ']'.repeat(n);
      const aceitos = [
        '{"a":[1,2,{"b":null}],"c":true,"d":false}',
        '"texto"',
        '-0',
        '1.5e300',
        '-1.5E-300',
        '123456789012345678901234567890123456789012345678901234567890',
        '{"a":"\\u00e7\\ud83d\\ude00"}',
        // Número dentro de string não é número, nem com aspas escapadas antes.
        '["1e999999", "aspas \\" e 1e999999"]',
        aninhado(PROFUNDIDADE_MAXIMA_JSON),
      ];
      const recusados = [
        aninhado(PROFUNDIDADE_MAXIMA_JSON + 1),
        aninhado(100_000),
        '1e200000',
        '[1e-99999]',
        '1e301',
        `1${'0'.repeat(64)}`,
        '1e308000',
        '{"a":"\\u0000"}',
        '{"\\ud800":1}',
        'nao e json',
        '[1,]',
        '',
      ];
      for (const texto of aceitos) expect(jsonAceitoPeloBanco(texto), texto.slice(0, 40)).toBe(true);
      for (const texto of recusados) expect(jsonAceitoPeloBanco(texto), texto.slice(0, 40)).toBe(false);
      for (const texto of aceitos) {
        const { rows } = await db.pool.query<{ ok: boolean }>('SELECT texto_e_json($1) AS ok', [texto]);
        expect(rows[0]!.ok, texto.slice(0, 40)).toBe(true);
      }
    });
  });

  describe('regras do banco', () => {
    type Campos = { formato: string; resumo: string; conteudo: string; bytes: number; sha256: string; referencias: string; classificacao: string };
    const inserirCru = (tarefaId: string, campos: Partial<Campos> = {}) => {
      const conteudo = campos.conteudo ?? 'Conteudo.';
      const v: Campos = {
        formato: 'texto',
        resumo: 'Resumo.',
        conteudo,
        bytes: Buffer.byteLength(conteudo, 'utf8'),
        sha256: sha256Hex(conteudo),
        referencias: '[]',
        classificacao: 'interna',
        ...campos,
      };
      return db.pool.query(
        `INSERT INTO artefatos_tarefa (tarefa_id, formato, resumo, conteudo, bytes, sha256, referencias, classificacao)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [tarefaId, v.formato, v.resumo, v.conteudo, v.bytes, v.sha256, v.referencias, v.classificacao],
      );
    };

    it('so uma tarefa em execucao, com envio registrado, recebe artefato; um por tarefa; append-only', async () => {
      const p = await planoAtivoDeTeste(db.pool);
      const sem = 'artefatos_tarefa: só uma tarefa em execução, com envio registrado, recebe artefato';
      await expect(inserirCru(p.ids.analise!)).rejects.toThrow(sem);
      const t = await reivindicar(db.pool, p.planoId);
      await expect(inserirCru(t.id)).rejects.toThrow(sem);
      await expect(inserirCru(p.ids.integracao!)).rejects.toThrow(sem);

      await enviar(db.pool, t);
      const { rows } = await inserirCru(t.id);
      await expect(inserirCru(t.id)).rejects.toThrow(/artefatos_tarefa_tarefa_id_key/);
      await expect(db.pool.query("UPDATE artefatos_tarefa SET resumo = 'Outro.' WHERE id = $1", [rows[0].id])).rejects.toThrow(
        'artefatos_tarefa é append-only: UPDATE não é permitido',
      );
      await expect(db.pool.query('DELETE FROM artefatos_tarefa WHERE id = $1', [rows[0].id])).rejects.toThrow(
        'artefatos_tarefa é append-only: DELETE não é permitido',
      );
    });

    it('o banco confere hash, tamanho, formato, classificacao e os limites por tipo', async () => {
      const p = await planoAtivoDeTeste(db.pool, [
        { chave: 'a', capacidade: 'd1' },
        { chave: 'b', capacidade: 'd2' },
      ]);
      const { tarefa: ta } = await reivindicarEEnviar(db.pool, p.planoId);

      await expect(inserirCru(ta.id, { sha256: sha256Hex('outro') })).rejects.toThrow(/artefatos_tarefa_sha256_check/);
      await expect(inserirCru(ta.id, { bytes: 1 })).rejects.toThrow(/artefatos_tarefa_bytes_check/);
      await expect(inserirCru(ta.id, { formato: 'json', conteudo: 'nao e json' })).rejects.toThrow(
        'artefatos_tarefa: formato json exige conteúdo JSON válido',
      );
      await expect(inserirCru(ta.id, { formato: 'html' })).rejects.toThrow(/artefatos_tarefa_formato_check/);
      await expect(inserirCru(ta.id, { classificacao: 'publica' })).rejects.toThrow(/artefatos_tarefa_classificacao_check/);
      await expect(inserirCru(ta.id, { resumo: 'x'.repeat(501) })).rejects.toThrow(/artefatos_tarefa_resumo_check/);
      await expect(inserirCru(ta.id, { conteudo: 'ç'.repeat(32_769) })).rejects.toThrow(
        'artefatos_tarefa: o artefato de especialista tem no máximo 65536 bytes',
      );
      await expect(inserirCru(ta.id, { referencias: JSON.stringify([{ tipo: 'url', url: 'http://example.com' }]) })).rejects.toThrow(
        'artefatos_tarefa: referências fora do formato fechado',
      );

      // Integração: o limite é 131.072 bytes, conferido pelo CHECK da tabela.
      await concluirTarefaEspecialista(db.pool, { tarefaId: ta.id, leaseToken: ta.leaseToken, artefato: artefatoDeTeste() });
      const { tarefa: tb } = await reivindicarEEnviar(db.pool, p.planoId);
      await concluirTarefaEspecialista(db.pool, { tarefaId: tb.id, leaseToken: tb.leaseToken, artefato: artefatoDeTeste() });
      const { tarefa: ti } = await reivindicarEEnviar(db.pool, p.planoId);
      await expect(inserirCru(ti.id, { conteudo: 'x'.repeat(LIMITE_BYTES_ARTEFATO_INTEGRACAO + 1) })).rejects.toThrow(
        /artefatos_tarefa_conteudo_check/,
      );
      await inserirCru(ti.id, { conteudo: 'x'.repeat(LIMITE_BYTES_ARTEFATO_ESPECIALISTA + 1) });
    });

    it('referencia a artefato so para uma dependencia direta', async () => {
      const p = await planoAtivoDeTeste(db.pool, [
        { chave: 'a', capacidade: 'd1' },
        { chave: 'b', capacidade: 'd2', dependeDe: ['a'] },
        { chave: 'c', capacidade: 'd3' },
      ]);
      const ref = (tarefaId: string) => JSON.stringify([{ tipo: 'artefato', tarefaId }]);
      const direta = 'artefatos_tarefa: uma referência a artefato só aponta para uma dependência direta';

      const { tarefa: ta } = await reivindicarEEnviar(db.pool, p.planoId);
      await concluirTarefaEspecialista(db.pool, { tarefaId: ta.id, leaseToken: ta.leaseToken, artefato: artefatoDeTeste() });
      const { tarefa: tb } = await reivindicarEEnviar(db.pool, p.planoId);
      const { tarefa: tc } = await reivindicarEEnviar(db.pool, p.planoId);
      expect([ta.chave, tb.chave, tc.chave]).toEqual(['a', 'b', 'c']);

      await expect(inserirCru(tc.id, { referencias: ref(p.ids.a!) })).rejects.toThrow(direta);
      await expect(inserirCru(tb.id, { referencias: ref(randomUUID()) })).rejects.toThrow(direta);
      await expect(inserirCru(tb.id, { referencias: ref(tb.id) })).rejects.toThrow(direta);
      await inserirCru(tb.id, { referencias: ref(p.ids.a!) });
    });

    it('inserirArtefato calcula hash e bytes; listarArtefatosDasDependencias devolve os das dependencias diretas em ordem de chave', async () => {
      const p = await planoAtivoDeTeste(db.pool, [
        { chave: 'b', capacidade: 'd2' },
        { chave: 'a', capacidade: 'd1' },
      ]);
      const conteudoA = 'Análise: ção.';
      const refsA = [{ tipo: 'url' as const, url: 'https://example.com/guia' }];
      const { tarefa: ta } = await reivindicarEEnviar(db.pool, p.planoId);
      const gravado = await comTransacao(db.pool, (c) => inserirArtefato(c, { tarefaId: ta.id, artefato: artefatoDeTeste(conteudoA, refsA) }));
      expect(gravado).toMatchObject({ bytes: Buffer.byteLength(conteudoA, 'utf8'), sha256: sha256Hex(conteudoA) });
      const { rows } = await db.pool.query('SELECT bytes, sha256, classificacao FROM artefatos_tarefa WHERE id = $1', [gravado.id]);
      expect(rows[0]).toEqual({ bytes: gravado.bytes, sha256: gravado.sha256, classificacao: 'interna' });
      await db.pool.query("UPDATE tarefas SET estado = 'concluida' WHERE id = $1", [ta.id]);

      const { tarefa: tb } = await reivindicarEEnviar(db.pool, p.planoId);
      await concluirTarefaEspecialista(db.pool, { tarefaId: tb.id, leaseToken: tb.leaseToken, artefato: artefatoDeTeste('Conteudo b.') });
      const { tarefa: ti } = await reivindicarEEnviar(db.pool, p.planoId);

      expect(await listarArtefatosDasDependencias(db.pool, ti.id)).toEqual([
        { tarefaId: ta.id, chave: 'a', formato: 'texto', resumo: 'Resumo do resultado.', conteudo: conteudoA, referencias: refsA, bytes: gravado.bytes },
        {
          tarefaId: tb.id,
          chave: 'b',
          formato: 'texto',
          resumo: 'Resumo do resultado.',
          conteudo: 'Conteudo b.',
          referencias: [],
          bytes: Buffer.byteLength('Conteudo b.', 'utf8'),
        },
      ]);
      expect(await listarArtefatosDasDependencias(db.pool, ta.id)).toEqual([]);
    });
  });
});
