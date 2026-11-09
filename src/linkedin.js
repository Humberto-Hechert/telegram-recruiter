// Busca no LinkedIn pelo endpoint público "guest" (o mesmo que a página de vagas usa sem login).
// Não é API oficial: o HTML pode mudar e o LinkedIn pode bloquear. Ver docs/DOCUMENTACAO.md → Troubleshooting.
import { htmlToText, jitter } from './util.js';

const GUEST_SEARCH = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
const GUEST_DETAIL = 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/';
const PUBLIC_SEARCH = 'https://www.linkedin.com/jobs/search/';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
};

/** O LinkedIn recusou a requisição (429, 999, authwall...). Carrega o que foi coletado antes do bloqueio. */
export class BlockedError extends Error {
  constructor(message, partial = []) {
    super(message);
    this.name = 'BlockedError';
    this.partial = partial;
  }
}

function searchParams({ keywords, location, geoId, workplaceTypes = [], experienceLevels = [], easyApplyOnly = false }, windowSeconds) {
  const params = new URLSearchParams({ keywords, location, f_TPR: `r${windowSeconds}`, sortBy: 'DD' });
  if (geoId) params.set('geoId', geoId);
  if (easyApplyOnly) params.set('f_AL', 'true'); // "Candidatura simplificada" (Easy Apply)
  if (workplaceTypes.length) params.set('f_WT', workplaceTypes.join(','));
  if (experienceLevels.length) params.set('f_E', experienceLevels.join(','));
  return params;
}

export function buildGuestSearchUrl(query, windowSeconds, start = 0) {
  const params = searchParams(query, windowSeconds);
  params.set('start', String(start));
  return `${GUEST_SEARCH}?${params}`;
}

/** URL da busca pública "normal" — é o formato que o Apify aceita. */
export function buildPublicSearchUrl(query, windowSeconds) {
  return `${PUBLIC_SEARCH}?${searchParams(query, windowSeconds)}`;
}

/**
 * Combinações grupo de termos × localização definidas no config.
 * Uma localização pode limitar os grupos (`groups`, por label) e o número de páginas (`maxPages`).
 */
export function buildQueries(searchConfig) {
  const queries = [];
  for (const group of searchConfig.keywordGroups) {
    for (const loc of searchConfig.locations) {
      if (loc.groups && !loc.groups.includes(group.label)) continue;
      queries.push({
        maxPages: loc.maxPages,
        label: `${group.label} @ ${loc.label}`,
        keywords: group.keywords,
        location: loc.location,
        geoId: loc.geoId,
        workplaceTypes: loc.workplaceTypes,
        experienceLevels: searchConfig.experienceLevels,
        easyApplyOnly: searchConfig.easyApplyOnly,
      });
    }
  }
  return queries;
}

async function fetchHtml(url, fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl(url, { headers: HEADERS, redirect: 'manual' });
  } catch (err) {
    throw new Error(`Falha de rede ao acessar o LinkedIn: ${err.message}`);
  }
  if ([429, 999, 403].includes(res.status)) throw new BlockedError(`LinkedIn respondeu HTTP ${res.status}`);
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location') || '';
    if (/authwall|login|checkpoint/i.test(location)) throw new BlockedError('LinkedIn redirecionou para login (authwall)');
  }
  if (res.status === 404) return '';
  if (!res.ok) throw new Error(`LinkedIn respondeu HTTP ${res.status}`);
  const html = await res.text();
  if (/authwall|uas\/login/i.test(html) && !/base-card|show-more-less-html/.test(html)) {
    throw new BlockedError('LinkedIn devolveu página de login (authwall)');
  }
  return html;
}

const pick = (html, regex) => {
  const match = html.match(regex);
  return match ? htmlToText(match[1]) : '';
};

/** Extrai os cards de vaga do HTML devolvido pela busca guest. */
export function parseSearchResults(html) {
  if (!html) return [];
  const chunks = html.split(/<li[\s>]/i).slice(1);
  const jobs = [];
  for (const chunk of chunks) {
    const id = chunk.match(/urn:li:jobPosting:(\d+)/)?.[1] || chunk.match(/\/jobs\/view\/[^"?]*?-(\d{6,})/)?.[1];
    if (!id) continue;
    const title = pick(chunk, /<h3[^>]*base-search-card__title[^>]*>([\s\S]*?)<\/h3>/i);
    const company = pick(chunk, /<h4[^>]*base-search-card__subtitle[^>]*>([\s\S]*?)<\/h4>/i);
    if (!title) continue;
    jobs.push({
      id,
      title,
      company,
      location: pick(chunk, /<span[^>]*job-search-card__location[^>]*>([\s\S]*?)<\/span>/i),
      salaryHint: pick(chunk, /<span[^>]*job-search-card__salary-info[^>]*>([\s\S]*?)<\/span>/i),
      listedAt: chunk.match(/<time[^>]*datetime="([^"]+)"/i)?.[1] || null,
      url: `https://www.linkedin.com/jobs/view/${id}/`,
      source: 'linkedin-guest',
    });
  }
  return jobs;
}

/** Extrai descrição, critérios (senioridade, tipo de contrato...) e salário da página de detalhe. */
export function parseJobDetail(html) {
  if (!html) return null;
  let description = '';
  const start = html.search(/<div[^>]*show-more-less-html__markup[^>]*>/i);
  if (start >= 0) {
    const afterOpen = html.indexOf('>', start) + 1;
    const rest = html.slice(afterOpen);
    const end = rest.search(/<button[^>]*show-more-less-html__button|<\/section>/i);
    description = htmlToText(end >= 0 ? rest.slice(0, end) : rest);
  }

  const criteria = {};
  const criteriaRegex = /<h3[^>]*description__job-criteria-subheader[^>]*>([\s\S]*?)<\/h3>\s*<span[^>]*description__job-criteria-text[^>]*>([\s\S]*?)<\/span>/gi;
  for (const match of html.matchAll(criteriaRegex)) {
    criteria[htmlToText(match[1])] = htmlToText(match[2]);
  }

  return {
    description,
    criteria,
    salaryText: pick(html, /<div[^>]*compensation__salary[^>]*>([\s\S]*?)<\/div>/i),
    title: pick(html, /<h2[^>]*top-card-layout__title[^>]*>([\s\S]*?)<\/h2>/i),
    company: pick(html, /<a[^>]*topcard__org-name-link[^>]*>([\s\S]*?)<\/a>/i),
  };
}

/**
 * Roda todas as buscas, paginando. Se o LinkedIn bloquear no meio,
 * lança BlockedError com o que já foi coletado em `partial`.
 */
export async function searchAll(searchConfig, windowSeconds, { fetchImpl = fetch, delay = jitter, log = console.log } = {}) {
  const byId = new Map();
  const queries = buildQueries(searchConfig);
  const failures = [];
  let first = true;
  for (const query of queries) {
    const maxPages = query.maxPages ?? searchConfig.maxPagesPerQuery;
    for (let page = 0; page < maxPages; page++) {
      if (!first) await delay(searchConfig.requestDelayMs);
      first = false;
      let html;
      try {
        html = await fetchHtml(buildGuestSearchUrl(query, windowSeconds, page * 10), fetchImpl);
      } catch (err) {
        if (err instanceof BlockedError) throw new BlockedError(err.message, [...byId.values()]);
        log(`  ! busca "${query.label}" falhou: ${err.message}`);
        failures.push(err.message);
        break;
      }
      const results = parseSearchResults(html);
      for (const job of results) if (!byId.has(job.id)) byId.set(job.id, { ...job, query: query.label });
      if (results.length < 10) break; // última página
    }
  }
  // Se TODAS as buscas falharam (sem ser bloqueio), algo está errado: falha para disparar o alerta.
  if (failures.length === queries.length) throw new Error(`Todas as ${queries.length} buscas no LinkedIn falharam: ${failures[0]}`);
  return [...byId.values()];
}

export async function fetchDetail(jobId, { fetchImpl = fetch } = {}) {
  return parseJobDetail(await fetchHtml(`${GUEST_DETAIL}${jobId}`, fetchImpl));
}

/** Uma única requisição barata para saber se o LinkedIn voltou a responder. */
export async function probe(searchConfig, { fetchImpl = fetch } = {}) {
  const [query] = buildQueries(searchConfig);
  try {
    await fetchHtml(buildGuestSearchUrl(query, 86400, 0), fetchImpl);
    return true;
  } catch {
    return false;
  }
}
