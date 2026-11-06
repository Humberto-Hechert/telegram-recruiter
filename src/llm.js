// Cliente de LLM com dois provedores: Gemini (principal) e Groq (reserva).
// - Respeita um intervalo mínimo entre chamadas para caber no free tier de cada um.
// - Erros passageiros (429 e 5xx, como "model is experiencing high demand") são tentados de novo
//   com espera crescente antes de passar para o próximo provedor.
// - GEMINI_MODEL aceita uma lista separada por vírgula (ex.: "gemini-3.5-flash-lite,gemini-3.5-flash"):
//   cada modelo vira um provedor, tentado na ordem.
// - Um modelo que responde 404 (descontinuado) é desligado pelo resto da execução.
// - OpenAI (pago) é o último recurso, só usado se tudo acima falhar, e respeita o teto mensal (budget.js).
import { sleep } from './util.js';
import { costFromUsage, worstCaseCost } from './budget.js';

export class ProviderError extends Error {
  constructor(message, { status, retryAfterMs } = {}) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
  get transient() {
    return this.status === 429 || this.status >= 500 || this.status === undefined;
  }
}

/** Extrai o JSON da resposta, mesmo que venha dentro de ```json ... ``` ou com texto em volta. */
export function parseJsonResponse(text) {
  const cleaned = String(text).replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Resposta do LLM sem JSON');
  return JSON.parse(cleaned.slice(start, end + 1));
}

/** Transforma a resposta de erro da API numa mensagem curta para o log. */
async function httpError(provider, res) {
  const body = await res.text().catch(() => '');
  let detail = body.slice(0, 200);
  try {
    const parsed = JSON.parse(body);
    detail = (parsed.error?.message || parsed.message || detail).slice(0, 200);
  } catch { /* corpo não é JSON */ }
  const retryAfter = Number(res.headers?.get?.('retry-after'));
  return new ProviderError(`${provider} HTTP ${res.status}: ${detail}`, {
    status: res.status,
    retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
  });
}

function throttled(minIntervalMs, fn) {
  let last = 0;
  return async (...args) => {
    const wait = last + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    return fn(...args);
  };
}

async function geminiCall({ apiKey, model, system, user, json, fetchImpl }) {
  const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { temperature: 0.2, ...(json ? { responseMimeType: 'application/json' } : {}) },
    }),
  });
  if (!res.ok) throw await httpError('Gemini', res);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  if (!text) throw new ProviderError(`Gemini sem conteúdo (finishReason: ${data.candidates?.[0]?.finishReason})`, { status: 200 });
  return text;
}

async function groqCall({ apiKey, model, system, user, json, fetchImpl }) {
  const res = await fetchImpl('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }),
  });
  if (!res.ok) throw await httpError('Groq', res);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

/** OpenAI (pago): último recurso. Devolve o texto e o `usage` para o controle de gastos. */
async function openaiCall({ apiKey, model, system, user, json, fetchImpl, maxCompletionTokens, reasoningEffort }) {
  const res = await fetchImpl('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_completion_tokens: maxCompletionTokens,
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }),
  });
  if (!res.ok) throw await httpError('OpenAI', res);
  const data = await res.json();
  return { text: data.choices?.[0]?.message?.content || '', usage: data.usage };
}

const DEFAULT_RETRY_DELAYS_MS = [8000, 20000];
const MAX_RETRY_WAIT_MS = 30000;

/**
 * Cria a função `complete({ system, user, json })` que tenta cada provedor na ordem.
 * Devolve { text, provider }.
 */
export function createLlm(env, llmConfig, { fetchImpl = fetch, log = console.log, retryDelaysMs = DEFAULT_RETRY_DELAYS_MS, wait = sleep, budget = null, openaiConfig = null } = {}) {
  const providers = [];
  const geminiModels = String(env.geminiModel || '').split(',').map((m) => m.trim()).filter(Boolean);
  if (env.geminiKey) {
    for (const model of geminiModels) {
      providers.push({
        name: `gemini:${model}`,
        call: throttled(llmConfig.geminiMinIntervalMs, (args) => geminiCall({ ...args, apiKey: env.geminiKey, model, fetchImpl })),
      });
    }
  }
  if (env.groqKey) {
    providers.push({
      name: `groq:${env.groqModel}`,
      call: throttled(llmConfig.groqMinIntervalMs, (args) => groqCall({ ...args, apiKey: env.groqKey, model: env.groqModel, fetchImpl })),
    });
  }
  // OpenAI só entra com chave + controle de gastos configurados, e sempre por último.
  if (env.openaiKey && budget && openaiConfig) {
    const model = env.openaiModel || openaiConfig.model;
    providers.push({
      name: `openai:${model}`,
      call: async (args) => {
        const estimate = worstCaseCost(args.system.length + args.user.length, openaiConfig.maxCompletionTokens, openaiConfig.pricePerMillion);
        if (!(await budget.canSpend(estimate))) {
          throw new ProviderError('teto mensal de gastos atingido', { status: 402 });
        }
        const { text, usage } = await openaiCall({
          ...args, apiKey: env.openaiKey, model, fetchImpl,
          maxCompletionTokens: openaiConfig.maxCompletionTokens, reasoningEffort: openaiConfig.reasoningEffort,
        });
        // Cobra mesmo se o JSON vier inválido: a OpenAI cobrou.
        await budget.record(usage ? costFromUsage(usage, openaiConfig.pricePerMillion) : estimate);
        return text;
      },
    });
  }
  if (!providers.length) return null;

  const disabled = new Set();

  async function tryProvider(provider, request) {
    for (let attempt = 0; ; attempt++) {
      try {
        const text = await provider.call(request);
        if (request.json) parseJsonResponse(text); // valida antes de aceitar
        return text;
      } catch (err) {
        const retriable = err instanceof ProviderError ? err.transient : false;
        if (err instanceof ProviderError && err.status === 404) {
          disabled.add(provider.name);
          log(`  ! ${provider.name} não existe mais (404): desligado nesta execução. Atualize GEMINI_MODEL/GROQ_MODEL/OPENAI_MODEL.`);
        }
        if (err instanceof ProviderError && err.status === 402) disabled.add(provider.name); // teto atingido
        if (!retriable || attempt >= retryDelaysMs.length) throw err;
        const delay = Math.min(err.retryAfterMs ?? retryDelaysMs[attempt], MAX_RETRY_WAIT_MS);
        log(`  ~ ${provider.name}: ${err.message} — tentando de novo em ${Math.round(delay / 1000)}s`);
        await wait(delay);
      }
    }
  }

  return async function complete({ system, user, json = false }) {
    const errors = [];
    for (const provider of providers) {
      if (disabled.has(provider.name)) continue;
      try {
        const text = await tryProvider(provider, { system, user, json });
        return { text, provider: provider.name };
      } catch (err) {
        errors.push(`${provider.name}: ${err.message}`);
        log(`  ! ${provider.name} falhou: ${err.message}`);
      }
    }
    throw new Error(`Todos os provedores de LLM falharam → ${errors.join(' | ') || 'todos desligados'}`);
  };
}
