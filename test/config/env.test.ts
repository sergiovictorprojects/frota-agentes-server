import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/env.ts';

const valido = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/frota',
  ANTHROPIC_API_KEY: 'sk-ant-chave-de-teste-0123456789',
  UI_PASSWORD: 'uma-senha-bem-longa-123',
  PUBLIC_BASE_URL: 'https://frota.exemplo.com/',
};

describe('loadConfig', () => {
  it('aplica os padroes quando so as variaveis obrigatorias existem', () => {
    const cfg = loadConfig(valido);
    expect(cfg.PORT).toBe(3000);
    expect(cfg.UI_USER).toBe('frota');
    expect(cfg.CRON_PROCESSAR_FILA).toBe('*/10 * * * *');
    expect(cfg.MONTHLY_BUDGET_USD).toBe(50);
    expect(cfg.MAX_DEMANDAS_POR_RUN).toBe(3);
    expect(cfg.MODEL_WORK).toBe('claude-sonnet-5');
  });

  it('remove a barra final de PUBLIC_BASE_URL', () => {
    expect(loadConfig(valido).PUBLIC_BASE_URL).toBe('https://frota.exemplo.com');
  });

  it('converte numeros vindos como texto', () => {
    const cfg = loadConfig({ ...valido, PORT: '8080', MONTHLY_BUDGET_USD: '75.5', MAX_DEMANDAS_POR_RUN: '5' });
    expect(cfg.PORT).toBe(8080);
    expect(cfg.MONTHLY_BUDGET_USD).toBe(75.5);
    expect(cfg.MAX_DEMANDAS_POR_RUN).toBe(5);
  });

  it('falha listando as variaveis obrigatorias ausentes', () => {
    expect(() => loadConfig({})).toThrowError(/DATABASE_URL/);
    expect(() => loadConfig({})).toThrowError(/ANTHROPIC_API_KEY/);
    expect(() => loadConfig({})).toThrowError(/UI_PASSWORD/);
    expect(() => loadConfig({})).toThrowError(/PUBLIC_BASE_URL/);
  });

  it('rejeita chave da Anthropic com formato invalido', () => {
    expect(() => loadConfig({ ...valido, ANTHROPIC_API_KEY: 'nao-e-uma-chave-valida-000000' })).toThrowError(
      /ANTHROPIC_API_KEY/,
    );
  });

  it('rejeita senha curta sem vazar o valor na mensagem', () => {
    let mensagem = '';
    try {
      loadConfig({ ...valido, UI_PASSWORD: 'hunter2' });
    } catch (e) {
      mensagem = (e as Error).message;
    }
    expect(mensagem).toMatch(/UI_PASSWORD/);
    expect(mensagem).not.toContain('hunter2');
  });

  it('usa o console como canal de aviso por padrao, sem exigir nada de e-mail', () => {
    const cfg = loadConfig(valido);
    expect(cfg.NOTIFY_CHANNEL).toBe('console');
    expect(cfg.RESEND_API_KEY).toBeUndefined();
    expect(cfg.NOTIFY_EMAIL_FROM).toBe('Frota <onboarding@resend.dev>');
  });

  it('com o canal email, exige a chave do provedor e o destinatario, citando so os nomes', () => {
    let mensagem = '';
    try {
      loadConfig({ ...valido, NOTIFY_CHANNEL: 'email' });
    } catch (e) {
      mensagem = (e as Error).message;
    }
    expect(mensagem).toMatch(/RESEND_API_KEY.*obrigatória quando NOTIFY_CHANNEL=email/);
    expect(mensagem).toMatch(/NOTIFY_EMAIL_TO.*obrigatória quando NOTIFY_CHANNEL=email/);
  });

  it('aceita o canal email completo', () => {
    const cfg = loadConfig({
      ...valido,
      NOTIFY_CHANNEL: 'email',
      RESEND_API_KEY: 're_chave_de_teste_1234567890',
      NOTIFY_EMAIL_TO: 'dono@exemplo.com',
    });
    expect(cfg).toMatchObject({ NOTIFY_CHANNEL: 'email', NOTIFY_EMAIL_TO: 'dono@exemplo.com' });
  });

  it('trata variaveis de e-mail vazias como ausentes e rejeita destinatario invalido', () => {
    expect(loadConfig({ ...valido, RESEND_API_KEY: '', NOTIFY_EMAIL_TO: '' }).RESEND_API_KEY).toBeUndefined();
    expect(() => loadConfig({ ...valido, NOTIFY_EMAIL_TO: 'isto-nao-e-um-email' })).toThrowError(/NOTIFY_EMAIL_TO/);
  });

  it('nao vaza a chave do provedor na mensagem de erro', () => {
    let mensagem = '';
    try {
      loadConfig({ ...valido, NOTIFY_CHANNEL: 'email', RESEND_API_KEY: 're_segredo_do_provedor_123', NOTIFY_EMAIL_TO: 'invalido' });
    } catch (e) {
      mensagem = (e as Error).message;
    }
    expect(mensagem).not.toContain('re_segredo_do_provedor_123');
  });

  it('exige senha da interface com pelo menos 16 caracteres', () => {
    expect(() => loadConfig({ ...valido, UI_PASSWORD: 'quinze-caracter' })).toThrowError(/UI_PASSWORD/);
    expect(loadConfig({ ...valido, UI_PASSWORD: 'dezesseis-caract1' }).UI_PASSWORD).toHaveLength(17);
  });

  it('mantem o prazo de recuperacao de demandas maior que o prazo do job no agendador', () => {
    expect(loadConfig(valido).STALE_CLAIM_MINUTES).toBeGreaterThan(60);
  });

  it('nunca inclui valores de segredo na mensagem de erro', () => {
    let mensagem = '';
    try {
      loadConfig({ ...valido, PORT: 'abc' });
    } catch (e) {
      mensagem = (e as Error).message;
    }
    expect(mensagem).not.toContain(valido.ANTHROPIC_API_KEY);
    expect(mensagem).not.toContain(valido.UI_PASSWORD);
  });

  it('rejeita orcamento nao positivo', () => {
    expect(() => loadConfig({ ...valido, MONTHLY_BUDGET_USD: '0' })).toThrowError(/MONTHLY_BUDGET_USD/);
  });
});
