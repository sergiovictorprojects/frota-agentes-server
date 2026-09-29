import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

interface ResultadoVitest {
  success?: unknown;
  numTotalTestSuites?: unknown;
  numFailedTestSuites?: unknown;
  numFailedTests?: unknown;
}

function inteiroNaoNegativo(valor: unknown): valor is number {
  return Number.isInteger(valor) && Number(valor) >= 0;
}

export function conferirResultadoVitest(resultado: ResultadoVitest): void {
  if (
    typeof resultado.success !== 'boolean' ||
    !inteiroNaoNegativo(resultado.numTotalTestSuites) ||
    !inteiroNaoNegativo(resultado.numFailedTestSuites) ||
    !inteiroNaoNegativo(resultado.numFailedTests)
  ) {
    throw new Error('Relatório JSON do Vitest inválido ou incompleto.');
  }

  if (resultado.numTotalTestSuites === 0) throw new Error('O Vitest não executou nenhuma suíte.');
  if (!resultado.success || resultado.numFailedTestSuites > 0 || resultado.numFailedTests > 0) {
    throw new Error(
      `Vitest reportou falhas: ${resultado.numFailedTestSuites} suíte(s), ${resultado.numFailedTests} teste(s).`,
    );
  }
}

async function main(): Promise<void> {
  const caminho = process.argv[2];
  if (!caminho) throw new Error('Informe o caminho do relatório JSON do Vitest.');
  const resultado = JSON.parse(await readFile(caminho, 'utf8')) as ResultadoVitest;
  conferirResultadoVitest(resultado);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
