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

test('o config gera 11 buscas: EUA só com os termos em inglês e 1 página', () => {
  const queries = buildQueries(loadConfig().search);
  assert.equal(queries.length, 11);
  const us = queries.filter((q) => q.location === 'United States');
  assert.deepEqual(us.map((q) => q.label), ['engenharia (en) @ EUA · remoto', 'ia (en) @ EUA · remoto']);
  assert.ok(us.every((q) => q.maxPages === 1));
  const sp = queries.find((q) => q.location.startsWith('São Paulo'));
  assert.deepEqual(sp.workplaceTypes, ['1', '2', '3']);
  assert.ok(!queries.some((q) => /Worldwide|Latin America/.test(q.location)));
});

test('termos em português não têm mais "Desenvolvedor" sozinho', () => {
  const pt = loadConfig().search.keywordGroups.find((g) => g.label === 'pt-br').keywords;
  const terms = pt.split(' OR ').map((t) => t.replace(/"/g, ''));
  assert.ok(!terms.includes('Desenvolvedor'));
  assert.ok(terms.includes('Desenvolvedor backend') && terms.includes('Desenvolvedor Node.js') && terms.includes('Desenvolvedor IA'));
});

test('maxPages da localização limita a paginação', async () => {
  const search = {
    keywordGroups: [{ label: 'g', keywords: 'x' }],
    locations: [{ label: 'l', location: 'United States', workplaceTypes: ['2'], maxPages: 1 }],
    experienceLevels: [], maxPagesPerQuery: 3, requestDelayMs: [0, 0],
  };
  const tenCards = Array.from({ length: 10 }, (_, i) =>
    `<li><div data-entity-urn="urn:li:jobPosting:${4000000 + i}"><h3 class="base-search-card__title">Job ${i}</h3><h4 class="base-search-card__subtitle">Co</h4></div></li>`).join('');
  let calls = 0;
  const jobs = await searchAll(search, 3600, { fetchImpl: async () => { calls++; return new Response(tenCards); }, delay: async () => {}, log: () => {} });
  assert.equal(calls, 1);
  assert.equal(jobs.length, 10);
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
