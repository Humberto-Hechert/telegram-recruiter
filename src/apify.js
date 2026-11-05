// Fonte reserva: actor do Apify que raspa o LinkedIn por nós (com proxies deles).
// Só é usado quando o endpoint guest bloqueia. Custa créditos (o plano free dá ~US$ 5/mês).
import { buildPublicSearchUrl, buildQueries } from './linkedin.js';
import { htmlToText } from './util.js';

const first = (obj, keys) => {
  for (const key of keys) {
    const value = key.split('.').reduce((acc, part) => acc?.[part], obj);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
};

/** Converte um item do dataset do actor para o mesmo formato da busca guest (+ descrição). */
export function mapApifyItem(item) {
  const url = first(item, ['link', 'jobUrl', 'url']) || '';
  const id = String(first(item, ['id', 'jobId']) || url.match(/(\d{6,})/)?.[1] || '');
  if (!id) return null;
  const salary = first(item, ['salaryInfo', 'salary', 'salaryText']);
  const descriptionHtml = first(item, ['descriptionHtml']);
  return {
    id,
    title: first(item, ['title', 'jobTitle']) || '',
    company: first(item, ['companyName', 'company', 'company.name']) || '',
    location: first(item, ['location', 'jobLocation']) || '',
    salaryHint: Array.isArray(salary) ? salary.join(' – ') : salary || '',
    listedAt: first(item, ['postedAt', 'publishedAt', 'postedDate']) || null,
    url: `https://www.linkedin.com/jobs/view/${id}/`,
    description: first(item, ['descriptionText', 'description']) || (descriptionHtml ? htmlToText(descriptionHtml) : ''),
    criteria: {
      'Seniority level': first(item, ['seniorityLevel', 'experienceLevel']),
      'Employment type': first(item, ['employmentType', 'contractType']),
    },
    source: 'apify',
  };
}

/**
 * Roda o actor de forma síncrona e devolve as vagas.
 * Formato de input do actor padrão (curious_coder~linkedin-jobs-scraper): { urls, limitPerSource, count, scrapeCompany }.
 * Se trocar de actor no config, ajuste `buildInput` e confira o `mapApifyItem`.
 */
export async function searchApify(searchConfig, apifyConfig, token, windowSeconds, { fetchImpl = fetch } = {}) {
  const urls = buildQueries(searchConfig).map((q) => buildPublicSearchUrl(q, windowSeconds));
  const input = {
    urls,
    limitPerSource: apifyConfig.maxPerSearch,
    count: apifyConfig.maxPerSearch * urls.length,
    scrapeCompany: false,
  };
  const endpoint = `https://api.apify.com/v2/acts/${apifyConfig.actorId}/run-sync-get-dataset-items?timeout=280`;
  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Apify respondeu HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const items = await res.json();
  const byId = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const job = mapApifyItem(item);
    if (job && job.title && !byId.has(job.id)) byId.set(job.id, job);
  }
  return [...byId.values()];
}
