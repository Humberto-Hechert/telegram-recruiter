// Cliente de LLM com dois provedores: Gemini (principal) e Groq (reserva).
// Respeita um intervalo mínimo entre chamadas para caber no free tier de cada um.
import { sleep } from './util.js';

export class RateLimitError extends Error {}

/** Extrai o JSON da resposta, mesmo que venha dentro de ```json ... ``` ou com texto em volta. */
export function parseJsonResponse(text) {
  const cleaned = String(text).replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Resposta do LLM sem JSON');
  return JSON.parse(cleaned.slice(start, end + 1));
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
  if (res.status === 429) throw new RateLimitError('Gemini: limite de requisições (429)');
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  if (!text) throw new Error(`Gemini sem conteúdo (finishReason: ${data.candidates?.[0]?.finishReason})`);
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
  if (res.status === 429) throw new RateLimitError('Groq: limite de requisições (429)');
  if (!res.ok) throw new Error(`Groq HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

/**
 * Cria a função `complete({ system, user, json })` que tenta o Gemini e cai para o Groq.
 * Devolve { text, provider }.
 */
export function createLlm(env, llmConfig, { fetchImpl = fetch, log = console.log } = {}) {
  const providers = [];
  if (env.geminiKey) {
    providers.push({
      name: `gemini:${env.geminiModel}`,
      call: throttled(llmConfig.geminiMinIntervalMs, (args) =>
        geminiCall({ ...args, apiKey: env.geminiKey, model: env.geminiModel, fetchImpl })),
    });
  }
  if (env.groqKey) {
    providers.push({
      name: `groq:${env.groqModel}`,
      call: throttled(llmConfig.groqMinIntervalMs, (args) =>
        groqCall({ ...args, apiKey: env.groqKey, model: env.groqModel, fetchImpl })),
    });
  }
  if (!providers.length) return null;

  return async function complete({ system, user, json = false }) {
    const errors = [];
    for (const provider of providers) {
      try {
        const text = await provider.call({ system, user, json });
        if (json) parseJsonResponse(text); // valida antes de aceitar
        return { text, provider: provider.name };
      } catch (err) {
        errors.push(`${provider.name}: ${err.message}`);
        log(`  ! ${provider.name} falhou (${err.message}), tentando o próximo provedor`);
      }
    }
    throw new Error(`Todos os provedores de LLM falharam → ${errors.join(' | ')}`);
  };
}
