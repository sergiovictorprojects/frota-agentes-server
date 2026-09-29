import { describe, expect, it } from 'vitest';
import { prepararArtefatosEntregaveis } from '../../src/artifacts/servico.ts';
import type { Agente } from '../../src/db/agentes.ts';
import { capacidadesPadraoDoAgente } from '../../src/domain/capacidades-agentes.ts';

function agente(categoria: Agente['categoria'], papel: Agente['papel'], estado: Agente['estado'] = 'ativo'): Agente {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    chave: categoria === 'gestores' ? 'frota:gestores' : `frota:${categoria}`,
    nome: categoria,
    descricao: categoria,
    categoria,
    papel,
    estado,
    versao: 1,
    modeloPermitido: 'modelo',
    politicaRef: null,
    capacidades: capacidadesPadraoDoAgente({ categoria, papel }),
    criadoEm: '2026-09-29T00:00:00.000Z',
    atualizadoEm: '2026-09-29T00:00:00.000Z',
  };
}

describe('serviço de artefatos entregáveis', () => {
  const publicador = agente('gestores', 'coordenador');

  it('renderiza quando gerador e publicador têm as capacidades necessárias', () => {
    const [arquivo] = prepararArtefatosEntregaveis(
      [{ nomeArquivo: 'Layout', formato: 'svg', conteudo: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>' }],
      agente('d11', 'executor'),
      publicador,
    );
    expect(arquivo).toMatchObject({ nomeArquivo: 'layout.svg', formato: 'svg', mimeType: 'image/svg+xml' });
  });

  it('recusa formato fora da especialidade e publicação sem coordenador ativo', () => {
    const proposta = [{ nomeArquivo: 'dados', formato: 'xlsx' as const, conteudo: '[["x"]]' }];
    expect(() => prepararArtefatosEntregaveis(proposta, agente('d11', 'executor'), publicador)).toThrow(/não pode gerar xlsx/);
    expect(() => prepararArtefatosEntregaveis(proposta, agente('d10', 'executor'), agente('gestores', 'coordenador', 'suspenso'))).toThrow(/não pode publicar/);
  });

  it('recusa mais arquivos que o limite do gerador e nomes finais duplicados', () => {
    const gerador = agente('d11', 'executor');
    const proposta = { nomeArquivo: 'x', formato: 'pdf' as const, conteudo: 'x' };
    expect(() => prepararArtefatosEntregaveis(Array(4).fill(proposta), gerador, publicador)).toThrow(/no máximo 3/);
    expect(() => prepararArtefatosEntregaveis([proposta, { ...proposta, nomeArquivo: 'X.pdf' }], gerador, publicador)).toThrow(/duplicado/);
  });
});
