// Normalização de salário para R$/mês, piso salarial e formatação para a mensagem.

const SYMBOLS = { BRL: 'R$', USD: 'US$', EUR: '€', GBP: '£', CAD: 'C$' };
const PERIOD_LABEL = { hora: '/hora', mes: '/mês', ano: '/ano' };

/** Câmbio do dia (quanto vale 1 unidade da moeda em BRL). Cai para os valores fixos do config se a API falhar. */
export async function fetchRatesToBRL(fallbackRates, { fetchImpl = fetch, log = console.log } = {}) {
  try {
    const res = await fetchImpl('https://open.er-api.com/v6/latest/BRL');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.result !== 'success' || !data.rates) throw new Error('resposta inesperada');
    const rates = {};
    for (const [currency, perBRL] of Object.entries(data.rates)) {
      if (perBRL > 0) rates[currency] = 1 / perBRL; // a API dá "quanto 1 BRL vale na moeda X"
    }
    rates.BRL = 1;
    return rates;
  } catch (err) {
    log(`  ! câmbio indisponível (${err.message}), usando valores fixos do config`);
    return { BRL: 1, ...fallbackRates };
  }
}

/** Valor mensal em BRL, usando o topo da faixa (critério generoso). null se não der para calcular. */
export function toMonthlyBRL(salary, rates, hoursPerMonth = 168) {
  if (!salary) return null;
  const value = Number(salary.max ?? salary.min);
  const currency = String(salary.moeda || 'BRL').toUpperCase();
  const rate = rates[currency];
  if (!value || !rate) return null;
  const monthly = { hora: value * hoursPerMonth, mes: value, ano: value / 12 }[salary.periodo] ?? value;
  return monthly * rate;
}

/**
 * Aplica o piso somente quando o salário vem da própria vaga.
 * CLT em BRL → piso CLT; PJ em BRL → piso PJ; moeda estrangeira → piso "foreign";
 * BRL sem tipo de contrato definido → piso CLT (o mais baixo, para não descartar à toa).
 */
export function passesFloor(informedSalary, rates, salaryConfig) {
  if (!informedSalary) return true;
  const monthly = toMonthlyBRL(informedSalary, rates, salaryConfig.hoursPerMonth);
  if (monthly === null) return true;
  const floors = salaryConfig.floorsBRLMonthly;
  const currency = String(informedSalary.moeda || 'BRL').toUpperCase();
  let floor;
  if (currency !== 'BRL') floor = floors.foreign;
  else if (informedSalary.contrato === 'PJ') floor = floors.PJ;
  else floor = floors.CLT;
  return monthly >= floor;
}

const fmt = (n) => Math.round(Number(n)).toLocaleString('pt-BR');

/** "US$ 4.000–5.500/mês (PJ) (estimativa IA)" */
export function formatSalary(salary, estimated) {
  if (!salary || (salary.min == null && salary.max == null)) return 'Não informada';
  const currency = String(salary.moeda || 'BRL').toUpperCase();
  const symbol = SYMBOLS[currency] || currency;
  const range = salary.min != null && salary.max != null && salary.min !== salary.max
    ? `${fmt(salary.min)}–${fmt(salary.max)}`
    : fmt(salary.max ?? salary.min);
  const contract = salary.contrato && salary.contrato !== 'indefinido' ? ` (${salary.contrato})` : '';
  return `${symbol} ${range}${PERIOD_LABEL[salary.periodo] || ''}${contract}${estimated ? ' (estimativa IA)' : ''}`;
}
