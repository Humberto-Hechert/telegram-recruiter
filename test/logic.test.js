import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { fingerprint, normalizeTitle, dateInTimezone } from '../src/util.js';
import { createPrefilter } from '../src/filters.js';
import { computeScore, classify } from '../src/scoring.js';
import { toMonthlyBRL, passesFloor, formatSalary } from '../src/salary.js';
import { parseJsonResponse } from '../src/llm.js';

const config = loadConfig();
const rates = { BRL: 1, USD: 5, EUR: 6 };

test('repostagens da mesma vaga geram o mesmo fingerprint', () => {
  assert.equal(normalizeTitle('Senior Backend Engineer (Remote)'), 'senior backend engineer');
  assert.equal(fingerprint('Acme', 'Senior Backend Engineer (Remote)'), fingerprint('ACME', 'Senior Backend Engineer - Remoto'));
  assert.notEqual(fingerprint('Acme', 'Senior Backend Engineer'), fingerprint('Acme', 'Senior Frontend Engineer'));
});

test('pré-filtro tira BairesDev e títulos fora do nível', () => {
  const prefilter = createPrefilter(config.filters);
  assert.equal(prefilter({ company: 'Baires Dev', title: 'Senior Node.js Developer' }).ok, false);
  assert.equal(prefilter({ company: 'Acme', title: 'Desenvolvedor Backend Júnior' }).ok, false);
  assert.equal(prefilter({ company: 'Acme', title: 'Desenvolvedor Jr' }).ok, false);
  assert.equal(prefilter({ company: 'Acme', title: 'Staff Software Engineer' }).ok, false);
  assert.equal(prefilter({ company: 'Outlier', title: 'AI Trainer - Coding' }).ok, false);
  assert.equal(prefilter({ company: 'Acme', title: 'Senior AI Engineer' }).ok, true);
  assert.equal(prefilter({ company: 'Acme', title: 'Engenheiro de IA Pleno' }).ok, true);
});

test('pré-filtro ampliado: tira outras stacks e funções, mantém as vagas-alvo', () => {
  const prefilter = createPrefilter(config.filters);
  const blocked = [
    'Senior Java Developer', 'Desenvolvedor .NET Pleno', 'C# Backend Engineer', 'Desenvolvedor PHP', 'Ruby on Rails Engineer',
    'Senior Frontend Engineer', 'Desenvolvedor Front-end', 'iOS Engineer', 'Android Developer', 'Mobile Engineer (React Native)',
    'QA Engineer', 'Analista de Qualidade', 'DevOps Engineer', 'SRE - Site Reliability Engineer', 'Analista de Suporte',
    'UX Designer', 'Data Scientist', 'Analista de Dados', 'Engineering Manager', 'Product Owner', 'Gerente de Projetos',
    'Technical Recruiter', 'Desenvolvedor SAP ABAP', 'Game Developer (Unity)', 'Embedded Software Engineer', 'Entry Level Software Engineer',
  ];
  for (const title of blocked) assert.equal(prefilter({ company: 'Acme', title }).ok, false, `deveria bloquear: ${title}`);

  const allowed = [
    'Senior Backend Engineer (Node.js)', 'Desenvolvedor Backend Pleno', 'Desenvolvedor Node.js Sênior', 'Analista Desenvolvedor Backend',
    'Software Engineer - JavaScript/TypeScript', 'Full Stack Engineer (Node/React)', 'LLM Engineer', 'Desenvolvedor de IA',
    'AI Engineer - Agents', 'Tech Lead Backend', 'Engenheiro de Software Sênior',
  ];
  for (const title of allowed) assert.equal(prefilter({ company: 'Acme', title }).ok, true, `deveria passar: ${title}`);
});

test('nota ponderada segue a régua 40/25/20/15', () => {
  const evaluation = { eliminada: false, notas: { stack: 90, tipo_trabalho: 80, experiencia: 60, outros: 50 } };
  // 90*.4 + 80*.25 + 60*.2 + 50*.15 = 36 + 20 + 12 + 7.5 = 75.5
  assert.equal(computeScore(evaluation, config.scoring.weights), 76);
  assert.equal(computeScore({ ...evaluation, eliminada: true }, config.scoring.weights), 0);
  assert.equal(computeScore({ eliminada: false, notas: { stack: 500 } }, config.scoring.weights), 40);
});

test('classificação: enviada ≥70, quase 60–69, abaixo do piso descarta', () => {
  const c = config.scoring;
  assert.equal(classify({ score: 70, eliminated: false, floorOk: true }, c), 'enviada');
  assert.equal(classify({ score: 69, eliminated: false, floorOk: true }, c), 'quase');
  assert.equal(classify({ score: 59, eliminated: false, floorOk: true }, c), 'baixa');
  assert.equal(classify({ score: 95, eliminated: false, floorOk: false }, c), 'abaixo_do_piso');
  assert.equal(classify({ score: 0, eliminated: true, floorOk: true }, c), 'eliminada');
});

test('salário vira R$/mês (topo da faixa)', () => {
  assert.equal(toMonthlyBRL({ min: 3000, max: 4000, moeda: 'USD', periodo: 'mes' }, rates), 20000);
  assert.equal(toMonthlyBRL({ max: 120000, moeda: 'USD', periodo: 'ano' }, rates), 50000);
  assert.equal(toMonthlyBRL({ max: 20, moeda: 'USD', periodo: 'hora' }, rates), 16800);
  assert.equal(toMonthlyBRL({ max: 10, moeda: 'XYZ', periodo: 'mes' }, rates), null);
});

test('piso: R$10k CLT, R$13k PJ, estrangeiro comparado com R$13k', () => {
  const s = config.salary;
  assert.equal(passesFloor(null, rates, s), true, 'sem salário informado não descarta');
  assert.equal(passesFloor({ max: 10000, moeda: 'BRL', periodo: 'mes', contrato: 'CLT' }, rates, s), true);
  assert.equal(passesFloor({ max: 9999, moeda: 'BRL', periodo: 'mes', contrato: 'CLT' }, rates, s), false);
  assert.equal(passesFloor({ max: 12000, moeda: 'BRL', periodo: 'mes', contrato: 'PJ' }, rates, s), false);
  assert.equal(passesFloor({ max: 12000, moeda: 'BRL', periodo: 'mes', contrato: 'indefinido' }, rates, s), true);
  assert.equal(passesFloor({ max: 2500, moeda: 'USD', periodo: 'mes', contrato: 'contractor' }, rates, s), false);
  assert.equal(passesFloor({ max: 3000, moeda: 'USD', periodo: 'mes', contrato: 'contractor' }, rates, s), true);
});

test('formata salário para a mensagem', () => {
  assert.equal(formatSalary({ min: 4000, max: 5500, moeda: 'USD', periodo: 'mes', contrato: 'contractor' }, true), 'US$ 4.000–5.500/mês (contractor) (estimativa IA)');
  assert.equal(formatSalary({ min: 12000, max: 12000, moeda: 'BRL', periodo: 'mes', contrato: 'CLT' }, false), 'R$ 12.000/mês (CLT)');
  assert.equal(formatSalary(null, false), 'Não informada');
});

test('lê JSON do LLM mesmo com cerca de código', () => {
  assert.deepEqual(parseJsonResponse('```json\n{"a": 1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonResponse('Claro! {"a": {"b": 2}} pronto'), { a: { b: 2 } });
  assert.throws(() => parseJsonResponse('sem json'));
});

test('a data do digest é a de São Paulo, não a de UTC', () => {
  // 02:00 UTC do dia 6 ainda é 23:00 do dia 5 em São Paulo
  assert.equal(dateInTimezone(new Date('2026-11-06T02:00:00Z'), 'America/Sao_Paulo'), '2026-11-05');
});
