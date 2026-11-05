import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSearchResults, parseJobDetail, buildGuestSearchUrl, buildQueries, searchAll, BlockedError } from '../src/linkedin.js';
import { mapApifyItem } from '../src/apify.js';
import { loadConfig } from '../src/config.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('extrai os cards da busca guest', () => {
  const jobs = parseSearchResults(fixture('search.html'));
  assert.equal(jobs.length, 3);
  assert.deepEqual(
    { id: jobs[0].id, title: jobs[0].title, company: jobs[0].company, location: jobs[0].location },
    { id: '4312345678', title: 'Senior Backend Engineer (Node.js)', company: 'Acme & Co', location: 'Brazil' },
  );
  assert.equal(jobs[0].salaryHint, 'US$4,000.00/mo - US$5,500.00/mo');
  assert.equal(jobs[0].listedAt, '2026-11-05');
  assert.equal(jobs[0].url, 'https://www.linkedin.com/jobs/view/4312345678/');
  assert.equal(jobs[1].company, 'Empresa X');
});

test('extrai descrição, critérios e salário da página de detalhe', () => {
  const detail = parseJobDetail(fixture('detail.html'));
  assert.match(detail.description, /We build AI agents/);
  assert.match(detail.description, /• 5\+ years with Node\.js/);
  assert.match(detail.description, /LLMs & RAG/);
  assert.doesNotMatch(detail.description, /Show more/);
  assert.equal(detail.criteria['Seniority level'], 'Mid-Senior level');
  assert.equal(detail.criteria['Employment type'], 'Contract');
  assert.equal(detail.salaryText, 'US$4,000.00/mo - US$5,500.00/mo');
  assert.equal(detail.company, 'Acme & Co');
});

test('monta a URL da busca guest com os filtros', () => {
  const url = new URL(buildGuestSearchUrl({ keywords: '"AI Engineer"', location: 'Brazil', geoId: '106057199', workplaceTypes: ['2'], experienceLevels: ['3', '4'] }, 3600, 10));
  assert.equal(url.searchParams.get('f_TPR'), 'r3600');
  assert.equal(url.searchParams.get('f_WT'), '2');
  assert.equal(url.searchParams.get('f_E'), '3,4');
  assert.equal(url.searchParams.get('start'), '10');
  assert.equal(url.searchParams.get('keywords'), '"AI Engineer"');
});

test('o config gera 3 grupos × 4 localizações = 12 buscas', () => {
  assert.equal(buildQueries(loadConfig().search).length, 12);
});

test('bloqueio no meio da busca devolve o que já foi coletado', async () => {
  const config = { ...loadConfig().search, maxPagesPerQuery: 1 };
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) return new Response(fixture('search.html'), { status: 200 });
    // 999 é o código "não-padrão" que o LinkedIn usa para bloquear (o construtor Response não aceita, então é um mock)
    return { status: 999, ok: false, headers: new Headers(), text: async () => '' };
  };
  await assert.rejects(
    searchAll(config, 3600, { fetchImpl, delay: async () => {}, log: () => {} }),
    (err) => err instanceof BlockedError && err.partial.length === 3,
  );
});

test('mapeia um item do Apify para o formato interno', () => {
  const job = mapApifyItem({
    id: '4312345678', title: 'AI Engineer', companyName: 'Acme', location: 'Remote',
    link: 'https://www.linkedin.com/jobs/view/ai-engineer-at-acme-4312345678', descriptionText: 'Build agents', salaryInfo: ['$100K', '$120K'],
  });
  assert.equal(job.id, '4312345678');
  assert.equal(job.company, 'Acme');
  assert.equal(job.description, 'Build agents');
  assert.equal(job.salaryHint, '$100K – $120K');
  assert.equal(job.source, 'apify');
});
