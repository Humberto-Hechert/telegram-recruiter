import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { createMemoryKv } from '../src/kv.js';
import { createStore } from '../src/store.js';
import { createBudget, costFromUsage, monthKey } from '../src/budget.js';
import { createLlm } from '../src/llm.js';

const config = loadConfig();
const prices = config.openai.pricePerMillion;
const silent = () => {};
const now = new Date('2026-11-05T15:00:00Z');

const err = (status) => Response.json({ error: { message: 'x' } }, { status });
const openaiOk = (content, usage = { prompt_tokens: 4000, completion_tokens: 800 }) =>
  Response.json({ choices: [{ message: { content } }], usage });

function setup({ spent = 0, responses }) {
  const store = createStore(createMemoryKv(), config.storage);
  const notes = [];
  const budget = createBudget({ store, openaiConfig: config.openai, timeZone: config.timezone, now, notify: async (t) => notes.push(t), log: silent, flushEvery: 1 });
  const calls = [];
  const fetchImpl = async (url) => { calls.push(String(url)); return responses.shift(); };
  const complete = createLlm(
    { geminiKey: 'g', geminiModel: 'gemini-a', groqKey: 'q', groqModel: 'groq-x', openaiKey: 'o' },
    { geminiMinIntervalMs: 0, groqMinIntervalMs: 0 },
    { fetchImpl, log: silent, retryDelaysMs: [], wait: async () => {}, budget, openaiConfig: config.openai },
  );
  return { store, budget, complete, calls, notes, init: () => spent && store.setState(`openai:${monthKey(now, config.timezone)}`, { spentUSD: spent, calls: 1 }) };
}

test('custo pelo usage: GPT-5 Nano com 4.000 de entrada e 800 de saída', () => {
  // 4000 × 0,05 + 800 × 0,40 = 200 + 320 = 520 por milhão → US$ 0,00052
  assert.equal(costFromUsage({ prompt_tokens: 4000, completion_tokens: 800 }, prices).toFixed(5), '0.00052');
  // com 3.000 tokens em cache: 1000 × 0,05 + 3000 × 0,005 + 800 × 0,40 = 50 + 15 + 320 = 385
  assert.equal(costFromUsage({ prompt_tokens: 4000, prompt_tokens_details: { cached_tokens: 3000 }, completion_tokens: 800 }, prices).toFixed(6), '0.000385');
});

test('o mês do teto é o de São Paulo', () => {
  assert.equal(monthKey(new Date('2026-12-01T02:00:00Z'), 'America/Sao_Paulo'), '2026-11');
});

test('OpenAI só é chamada depois que Gemini e Groq falham, e o gasto é registrado', async () => {
  const { complete, calls, store } = setup({ responses: [err(400), err(400), openaiOk('{"ok":1}')] });
  const r = await complete({ system: 's', user: 'u', json: true });
  assert.equal(r.provider, 'openai:gpt-5-nano');
  assert.equal(calls.length, 3);
  assert.match(calls[2], /api\.openai\.com/);
  const saved = await store.getState(`openai:${monthKey(now, config.timezone)}`);
  assert.equal(saved.calls, 1);
  assert.equal(saved.spentUSD.toFixed(5), '0.00052');
});

test('com o teto atingido, a OpenAI não é chamada e o aviso sai uma vez só', async () => {
  const ctx = setup({ spent: 1.9995, responses: [err(400), err(400), err(400), err(400)] });
  await ctx.init();
  await assert.rejects(ctx.complete({ system: 's', user: 'u', json: true }), /teto mensal/);
  await assert.rejects(ctx.complete({ system: 's', user: 'u', json: true }), /todos desligados|Gemini|Groq/);
  assert.equal(ctx.calls.filter((u) => u.includes('openai.com')).length, 0);
  assert.equal(ctx.notes.length, 1);
  assert.match(ctx.notes[0], /Teto de US\$ 2\.00/);
});

test('sem OPENAI_API_KEY, a OpenAI nem entra na lista', async () => {
  const store = createStore(createMemoryKv(), config.storage);
  const budget = createBudget({ store, openaiConfig: config.openai, timeZone: config.timezone, log: silent });
  const complete = createLlm({ geminiKey: 'g', geminiModel: 'a' }, { geminiMinIntervalMs: 0 }, {
    fetchImpl: async () => err(400), log: silent, retryDelaysMs: [], budget, openaiConfig: config.openai,
  });
  await assert.rejects(complete({ system: 's', user: 'u' }), (e) => !/openai/.test(e.message));
});
