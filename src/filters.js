// Pré-filtro barato, ANTES de gastar requisição de detalhe e chamada de LLM.
import { normalizeText } from './util.js';

const compact = (text) => normalizeText(text).replace(/ /g, '');

export function createPrefilter(filtersConfig) {
  const companies = filtersConfig.excludedCompanies.map(compact);
  const patterns = filtersConfig.excludedTitlePatterns.map((p) => new RegExp(p, 'i'));

  return function prefilter(job) {
    const company = compact(job.company);
    if (company && companies.some((c) => company.includes(c))) {
      return { ok: false, reason: 'empresa excluída' };
    }
    const pattern = patterns.find((p) => p.test(job.title));
    if (pattern) return { ok: false, reason: `título bate em ${pattern}` };
    return { ok: true };
  };
}
