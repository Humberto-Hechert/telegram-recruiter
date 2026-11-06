import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLlm } from '../src/llm.js';

const llmConfig = { geminiMinIntervalMs: 0, groqMinIntervalMs: 0 };
const ok = (text) => Response.json({ candidates: [{ content: { parts: [{ text }] } }] });
const err = (status, message) => Response.json({ error: { code: status, message } }, { status });

function setup(responses, env = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const next = responses.shift();
    return typeof next === 'function' ? next(url) : next;
  };
  const complete = createLlm(
    { geminiKey: 'g', geminiModel: 'gemini-a', groqKey: 'q', groqModel: 'groq-x', ...env },
    llmConfig,
    { fetchImpl, log: () => {}, retryDelaysMs: [1, 1], wait: async () => {} },
  );
  return { complete, calls };
}

test('503 passageiro é tentado de novo no mesmo provedor', async () => {
  const { complete, calls } = setup([err(503, 'high demand'), ok('{"a":1}')]);
  const r = await complete({ system: 's', user: 'u', json: true });
  assert.equal(r.provider, 'gemini:gemini-a');
  assert.equal(calls.length, 2);
});

test('depois de esgotar as tentativas, cai para o próximo provedor', async () => {
  const { complete } = setup([
    err(503, 'x'), err(503, 'x'), err(503, 'x'),
    Response.json({ choices: [{ message: { content: '{"b":2}' } }] }),
  ]);
  const r = await complete({ system: 's', user: 'u', json: true });
  assert.equal(r.provider, 'groq:groq-x');
});

test('GEMINI_MODEL com lista tenta o segundo modelo antes do Groq', async () => {
  const { complete, calls } = setup([err(503, 'x'), err(503, 'x'), err(503, 'x'), ok('{"c":3}')], { geminiModel: 'gemini-a, gemini-b' });
  const r = await complete({ system: 's', user: 'u', json: true });
  assert.equal(r.provider, 'gemini:gemini-b');
  assert.match(calls.at(-1), /gemini-b/);
});

test('modelo 404 é desligado e não é chamado de novo', async () => {
  const groqOk = () => Response.json({ choices: [{ message: { content: '{"d":4}' } }] });
  const { complete, calls } = setup([err(404, 'no longer available'), groqOk(), groqOk()]);
  await complete({ system: 's', user: 'u', json: true });
  await complete({ system: 's', user: 'u', json: true });
  assert.equal(calls.filter((u) => u.includes('gemini-a')).length, 1);
});

test('erro 400 não é repetido', async () => {
  const { complete, calls } = setup([err(400, 'bad'), Response.json({ choices: [{ message: { content: '{}' } }] })]);
  await complete({ system: 's', user: 'u', json: true });
  assert.equal(calls.filter((u) => u.includes('gemini-a')).length, 1);
});
