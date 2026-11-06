// Teto de gastos mensal para o provedor pago (OpenAI).
//
// O gasto do mês fica no KV em `state:openai:<AAAA-MM>` = { spentUSD, calls } (mês de São Paulo).
// Antes de cada chamada, o custo PIOR caso (entrada estimada + máximo de saída) precisa caber no que
// sobra do teto. Depois da chamada, o custo REAL (pelo `usage` da resposta) é somado.
// O Worker do botão de carta usa a mesma chave, então o teto vale para os dois.
//
// Para economizar gravações no KV, o total é salvo a cada `flushEvery` chamadas e no fim da execução.

export function monthKey(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}`;
}

/** Custo em US$ de uma chamada, a partir do `usage` da API (chat completions). */
export function costFromUsage(usage, prices) {
  const prompt = usage?.prompt_tokens || 0;
  const cached = usage?.prompt_tokens_details?.cached_tokens || 0;
  const completion = usage?.completion_tokens || 0; // já inclui os tokens de raciocínio
  return ((prompt - cached) * prices.input + cached * prices.cachedInput + completion * prices.output) / 1e6;
}

/** Custo máximo possível de uma chamada (para decidir se cabe no teto ANTES de chamar). */
export function worstCaseCost(promptChars, maxCompletionTokens, prices) {
  const promptTokens = Math.ceil(promptChars / 3); // estimativa conservadora (~3 caracteres por token)
  return (promptTokens * prices.input + maxCompletionTokens * prices.output) / 1e6;
}

export function createBudget({ store, openaiConfig, timeZone, now = new Date(), notify = async () => {}, log = console.log, flushEvery = 10 }) {
  const month = monthKey(now, timeZone);
  const key = `openai:${month}`;
  const cap = openaiConfig.monthlyBudgetUSD;
  let state = { spentUSD: 0, calls: 0 };
  let unsaved = 0;
  let loaded = false;

  async function load() {
    if (loaded) return;
    state = (await store.getState(key)) || state;
    loaded = true;
  }

  async function flush() {
    if (!unsaved) return;
    await store.setState(key, state, 40 * 86400); // some sozinho depois do mês
    unsaved = 0;
  }

  async function alertOnce() {
    if (await store.getState(`openai-alerta:${month}`)) return;
    await notify(`💸 Teto de US$ ${cap.toFixed(2)} da OpenAI atingido em ${month} (gasto: US$ ${state.spentUSD.toFixed(4)}, ${state.calls} chamadas). Ela fica desligada até o mês virar.`);
    await store.setState(`openai-alerta:${month}`, true, 40 * 86400);
  }

  return {
    month,
    get spentUSD() { return state.spentUSD; },
    get calls() { return state.calls; },
    load,
    flush,
    /** true se o pior caso desta chamada cabe no que sobra do teto. */
    async canSpend(estimateUSD) {
      await load();
      if (state.spentUSD + estimateUSD <= cap) return true;
      log(`  $ teto da OpenAI: gasto US$ ${state.spentUSD.toFixed(4)} de US$ ${cap.toFixed(2)} em ${month}`);
      await alertOnce();
      return false;
    },
    async record(costUSD) {
      await load();
      state = { spentUSD: state.spentUSD + costUSD, calls: state.calls + 1 };
      unsaved++;
      if (unsaved >= flushEvery) await flush();
    },
  };
}
