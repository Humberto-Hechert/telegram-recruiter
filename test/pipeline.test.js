import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { createMemoryKv } from '../src/kv.js';
import { createStore } from '../src/store.js';
import { createPrefilter } from '../src/filters.js';
import { processJobs } from '../src/pipeline.js';
import { collectJobs } from '../src/source.js';
import { BlockedError } from '../src/linkedin.js';
import { fingerprint } from '../src/util.js';

const config = loadConfig();
const silent = () => {};

const job = (id, title, company = 'Acme') => ({ id, title, company, location: 'Brazil', url: `https://www.linkedin.com/jobs/view/${id}/` });

/** LLM falso: a nota "stack" vem do título para cada teste controlar o resultado. */
function fakeLlm(byTitle) {
  return async ({ user }) => {
    const title = user.match(/Título: (.*)/)[1];
    const r = byTitle[title];
    return {
      provider: 'fake',
      text: JSON.stringify({
        eliminada: r.eliminada ?? false,
        motivo_eliminacao: r.eliminada ? 'exige residência nos EUA' : null,
        notas: { stack: r.nota, tipo_trabalho: r.nota, experiencia: r.nota, outros: r.nota },
        resumo: 'Empresa de IA procurando back-end.', por_que_combina: 'Node + LLM', ponto_de_atencao: null,
        local_resumo: 'Remoto (LATAM)', idioma_vaga: 'en',
        salario_informado: r.salario ?? null,
        salario_estimado: { min: 4000, max: 5500, moeda: 'USD', periodo: 'mes', contrato: 'contractor' },
      }),
    };
  };
}

function setup(llmByTitle) {
  const kv = createMemoryKv();
  const store = createStore(kv, config.storage);
  const sent = [];
  const ctx = {
    config, profile: 'perfil', store,
    prefilter: createPrefilter(config.filters),
    complete: fakeLlm(llmByTitle),
    telegram: { sendMessage: async (text, opts) => sent.push({ text, opts }) },
    fetchDetail: async () => ({ description: 'descrição', criteria: {}, salaryText: '' }),
    getRates: async () => ({ BRL: 1, USD: 5 }),
    today: '2026-11-05',
    log: silent,
  };
  return { kv, store, sent, ctx };
}

test('pipeline: envia ≥70, guarda 60–69 no digest, descarta o resto, e não repete', async () => {
  const { kv, store, sent, ctx } = setup({
    'Senior AI Engineer': { nota: 85 },
    'Backend Engineer': { nota: 65 },
    'Software Engineer': { nota: 40 },
    'Node.js Developer': { nota: 95, eliminada: true },
    'AI Developer': { nota: 90, salario: { max: 8000, moeda: 'BRL', periodo: 'mes', contrato: 'CLT' } },
  });
  const jobs = [
    job('1', 'Senior AI Engineer'),
    job('2', 'Backend Engineer'),
    job('3', 'Software Engineer'),
    job('4', 'Node.js Developer'),
    job('5', 'AI Developer'),
    job('6', 'Desenvolvedor Júnior'),          // pré-filtro
    job('7', 'Senior AI Engineer (Remote)'),   // repostagem do 1 (mesmo fingerprint)
  ];

  const stats = await processJobs(jobs, ctx);
  assert.equal(stats.enviadas, 1);
  assert.equal(stats.quase, 1);
  assert.equal(stats.descartadas, 3); // baixa + eliminada + abaixo do piso
  assert.equal(stats.prefiltradas, 1);
  assert.equal(stats.repetidas, 1);

  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /85%/);
  assert.match(sent[0].text, /US\$ 4\.000–5\.500\/mês \(contractor\) \(estimativa IA\)/);
  const fp = fingerprint('Acme', 'Senior AI Engineer');
  assert.equal(sent[0].opts.buttons[0][1].callback_data, `carta:${fp}`);

  const saved = await kv.get(`vaga:${fp}`);
  assert.equal(saved.status, 'enviada');
  assert.equal(saved.idioma, 'en');
  assert.equal(saved.description, 'descrição');
  assert.equal((await store.listNearMisses('2026-11-05')).length, 1);

  // Segunda execução com as mesmas vagas: nada novo.
  const again = await processJobs(jobs, ctx);
  assert.equal(again.avaliadas, 0);
  assert.equal(sent.length, 1);
});

test('pipeline: se o Telegram falha, a vaga não é marcada e volta na próxima execução', async () => {
  const { store, ctx } = setup({ 'Senior AI Engineer': { nota: 90 } });
  ctx.telegram = { sendMessage: async () => { throw new Error('telegram fora'); } };
  const stats = await processJobs([job('1', 'Senior AI Engineer')], ctx);
  assert.equal(stats.erros, 1);
  assert.equal(await store.isSeen(fingerprint('Acme', 'Senior AI Engineer')), false);
});

test('pipeline: bloqueio ao buscar detalhe para o lote e sinaliza', async () => {
  const { ctx } = setup({ A: { nota: 90 }, B: { nota: 90 } });
  ctx.fetchDetail = async () => { throw new BlockedError('HTTP 999'); };
  const stats = await processJobs([job('1', 'A'), job('2', 'B', 'Outra')], ctx);
  assert.equal(stats.bloqueio, 'HTTP 999');
  assert.equal(stats.adiadas, 2);
});

test('fonte: bloqueio troca para Apify e avisa; probe ok volta para guest', async () => {
  const store = createStore(createMemoryKv(), config.storage);
  const notes = [];
  const notify = async (t) => notes.push(t);
  let blocked = true;
  const linkedin = {
    searchAll: async () => { if (blocked) throw new BlockedError('HTTP 429', []); return [job('1', 'A')]; },
    probe: async () => !blocked,
  };
  const apify = { searchApify: async () => [job('9', 'Via Apify')] };
  const env = { apifyToken: 'x' };
  const t0 = Date.parse('2026-11-05T12:00:00Z');

  // 1) LinkedIn bloqueia → troca para Apify e já busca por lá
  let r = await collectJobs({ config, env, store, notify, linkedin, apify, now: t0, log: silent });
  assert.equal(r.source, 'apify');
  assert.equal(r.jobs[0].title, 'Via Apify');
  assert.match(notes[0], /bloqueou/);

  // 2) 15 min depois, ainda bloqueado: espera o intervalo de 2h do Apify
  r = await collectJobs({ config, env, store, notify, linkedin, apify, now: t0 + 15 * 60000, log: silent });
  assert.equal(r.source, 'apify-aguardando');
  assert.equal(r.jobs.length, 0);

  // 3) LinkedIn volta → probe ok, volta para guest e avisa
  blocked = false;
  r = await collectJobs({ config, env, store, notify, linkedin, apify, now: t0 + 30 * 60000, log: silent });
  assert.equal(r.source, 'guest');
  assert.match(notes[1], /voltou/);
  assert.equal(notes.length, 2);
});

test('fonte: primeira execução varre 24h, depois 1h', async () => {
  const store = createStore(createMemoryKv(), config.storage);
  const windows = [];
  const linkedin = { searchAll: async (_, w) => { windows.push(w); return []; }, probe: async () => true };
  const r = await collectJobs({ config, env: {}, store, notify: silent, linkedin, apify: {}, log: silent });
  assert.equal(r.firstRun, true);
  await store.setState('initialized', 'x');
  await collectJobs({ config, env: {}, store, notify: silent, linkedin, apify: {}, log: silent });
  assert.deepEqual(windows, [86400, 3600]);
});
