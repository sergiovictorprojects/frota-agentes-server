import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { renderizarArtefatoEntregavel } from '../../src/artifacts/renderizadores.ts';
import { inserirArtefatosEntregaveis, listarArtefatosEntregaveisDaDemanda, obterArtefatoEntregavel } from '../../src/db/artefatos-entregaveis.ts';
import { criarDemanda } from '../../src/db/demandas.ts';
import { criarEntrega } from '../../src/db/relatorios.ts';
import { SETORES } from '../../src/domain/setores.ts';
import { createTestDb, type TestDb } from '../helpers/db.ts';

describe('artefatos_entregaveis (migration 007)', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => db.drop());
  beforeEach(async () => db.pool.query('TRUNCATE demandas CASCADE'));

  it('persiste bytes e metadados imutáveis vinculados à entrega e à demanda', async () => {
    const demanda = await criarDemanda(db.pool, { titulo: 'Arquivo', categoria: 'd1' });
    const entrega = await criarEntrega(db.pool, { demandaId: demanda.id, titulo: 'Entrega', conteudo: '<p>ok</p>' });
    const pdf = renderizarArtefatoEntregavel({ nomeArquivo: 'Relatório', formato: 'pdf', conteudo: 'Conteúdo' });

    const [salvo] = await inserirArtefatosEntregaveis(db.pool, {
      demandaId: demanda.id,
      entregaId: entrega.id,
      geradoPor: SETORES.d1.papel,
      publicadoPor: SETORES.gestores.papel,
      artefatos: [pdf],
    });

    expect(salvo).toMatchObject({ nomeArquivo: 'relatorio.pdf', formato: 'pdf', mimeType: 'application/pdf', bytes: pdf.bytes, sha256: pdf.sha256 });
    expect(await listarArtefatosEntregaveisDaDemanda(db.pool, demanda.id)).toEqual([salvo]);
    expect((await obterArtefatoEntregavel(db.pool, salvo!.id))!.conteudo).toEqual(pdf.conteudo);
    await expect(db.pool.query("UPDATE artefatos_entregaveis SET nome_arquivo = 'outro.pdf' WHERE id = $1", [salvo!.id])).rejects.toThrow(/append-only/);
    await expect(db.pool.query('DELETE FROM artefatos_entregaveis WHERE id = $1', [salvo!.id])).rejects.toThrow(/append-only/);
  });

  it('recusa MIME, hash, vínculo ou agentes sem capacidade', async () => {
    const demanda = await criarDemanda(db.pool, { titulo: 'Arquivo', categoria: 'd1' });
    const outra = await criarDemanda(db.pool, { titulo: 'Outra', categoria: 'd1' });
    const entrega = await criarEntrega(db.pool, { demandaId: demanda.id, titulo: 'Entrega', conteudo: '<p>ok</p>' });
    const txt = renderizarArtefatoEntregavel({ nomeArquivo: 'x', formato: 'txt', conteudo: 'x' });
    const inserir = (mudancas: Record<string, unknown> = {}) => {
      const p = {
        demandaId: demanda.id,
        entregaId: entrega.id,
        ordem: 1,
        formato: txt.formato,
        nome: txt.nomeArquivo,
        mime: txt.mimeType,
        conteudo: txt.conteudo,
        bytes: txt.bytes,
        hash: txt.sha256,
        gerador: SETORES.d1.papel,
        publicador: SETORES.gestores.papel,
        ...mudancas,
      };
      return db.pool.query(
        `INSERT INTO artefatos_entregaveis
          (demanda_id, entrega_id, ordem, formato, nome_arquivo, mime_type, conteudo, bytes, sha256, gerado_por, publicado_por)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [p.demandaId, p.entregaId, p.ordem, p.formato, p.nome, p.mime, p.conteudo, p.bytes, p.hash, p.gerador, p.publicador],
      );
    };

    await expect(inserir({ mime: 'application/octet-stream' })).rejects.toThrow();
    await expect(inserir({ hash: '0'.repeat(64) })).rejects.toThrow();
    await expect(inserir({ demandaId: outra.id })).rejects.toThrow(/não pertence/);
    await expect(inserir({ gerador: SETORES.d17.papel })).rejects.toThrow(/não autorizado a gerar/);
    await expect(inserir({ publicador: SETORES.d1.papel })).rejects.toThrow(/não autorizado a publicar/);
  });
});
