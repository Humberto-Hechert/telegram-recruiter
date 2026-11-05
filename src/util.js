import { createHash } from 'node:crypto';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Espera um tempo aleatório entre [min, max] ms, para não parecer um robô. */
export const jitter = ([min, max]) => sleep(min + Math.floor(Math.random() * (max - min)));

/** Minúsculas, sem acentos, só letras/números separados por um espaço. */
export function normalizeText(text = '') {
  return String(text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Palavras que variam entre repostagens da mesma vaga e não mudam o que ela é.
const TITLE_NOISE = new Set([
  'remote', 'remoto', 'remota', 'hybrid', 'hibrido', 'hibrida', 'brazil', 'brasil',
  'latam', 'latin', 'america', 'worldwide', 'anywhere', 'home', 'office', 'sp', 'sao', 'paulo',
  'clt', 'pj', 'contractor', 'full', 'time', 'fulltime', '100',
]);

/** Título normalizado para detectar repostagens ("Sr. Backend Eng (Remote)" ≈ "Sr. Backend Eng - Remoto"). */
export function normalizeTitle(title = '') {
  const withoutBrackets = String(title).replace(/\([^)]*\)|\[[^\]]*\]/g, ' ');
  return normalizeText(withoutBrackets)
    .split(' ')
    .filter((word) => word && !TITLE_NOISE.has(word))
    .join(' ');
}

/** Identidade da vaga para deduplicação: empresa + título normalizado. */
export function fingerprint(company, title) {
  const base = `${normalizeText(company)}|${normalizeTitle(title)}`;
  return createHash('sha1').update(base).digest('hex').slice(0, 16);
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

export function decodeEntities(text = '') {
  return String(text)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z0-9#]+);/gi, (match, name) => ENTITIES[name.toLowerCase()] ?? match);
}

/** Converte HTML em texto legível, preservando quebras de linha de parágrafos e listas. */
export function htmlToText(html = '') {
  const text = String(html)
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '\n• ')
    .replace(/<\/\s*(p|div|li|ul|ol|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(text)
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Escapa texto para o parse_mode HTML do Telegram. */
export function escapeHtml(text = '') {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Data AAAA-MM-DD no fuso informado (o digest usa o dia de São Paulo, não o de UTC). */
export function dateInTimezone(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export function truncate(text = '', max) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
