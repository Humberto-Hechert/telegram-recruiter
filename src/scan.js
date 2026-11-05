// Ponto de entrada da busca. Roda no GitHub Actions a cada 15 min (disparado pelo cron-job.org).
import { loadEnv, loadProfile } from './config.js';
import { buildContext } from './context.js';
import { createLlm } from './llm.js';
import { createPrefilter } from './filters.js';
import { fetchRatesToBRL } from './salary.js';
import { collectJobs, switchToApify } from './source.js';
import { processJobs } from './pipeline.js';
import * as linkedin from './linkedin.js';
import * as apify from './apify.js';
import { dateInTimezone, escapeHtml } from './util.js';

const log = (...args) => console.log(...args);

async function alertError(store, telegram, config, err) {
  try {
    const last = await store.getState('lastErrorAlert');
    if (last && Date.now() - Number(last) < config.alerts.errorCooldownHours * 3600_000) return;
    await telegram.sendMessage(`🔴 <b>Robô de vagas falhou</b>\n${escapeHtml(err.message)}\n\nVeja o log da execução no GitHub Actions.`);
    await store.setState('lastErrorAlert', Date.now(), config.alerts.errorCooldownHours * 3600);
  } catch (alertErr) {
    log(`! não consegui nem avisar o erro: ${alertErr.message}`);
  }
}

async function main() {
  const startedAt = Date.now();
  const env = loadEnv();
  const { config, store, telegram } = buildContext(env, log);
  const notify = (text) => telegram.sendMessage(text);

  try {
    const { jobs, source, firstRun } = await collectJobs({ config, env, store, notify, linkedin, apify, log });
    log(`Fonte: ${source}${firstRun ? ' (primeira execução: últimas 24h)' : ''} · ${jobs.length} vagas encontradas`);

    let rates;
    const stats = await processJobs(jobs, {
      config,
      profile: loadProfile(),
      store,
      prefilter: createPrefilter(config.filters),
      complete: createLlm(env, config.llm, { log }),
      telegram,
      fetchDetail: (id) => linkedin.fetchDetail(id),
      getRates: async () => (rates ??= await fetchRatesToBRL(config.salary.fallbackRatesToBRL, { log })),
      today: dateInTimezone(new Date(), config.timezone),
      log,
      logJobs: env.logJobs,
    });

    // Bloqueio ao buscar detalhes (a busca em si passou). Se veio de 'guest-parcial', a troca já foi feita.
    if (stats.bloqueio && source === 'guest') await switchToApify(store, notify, stats.bloqueio, Date.now());
    if (firstRun) await store.setState('initialized', new Date().toISOString());

    log(`Resumo: ${JSON.stringify(stats)} · ${Math.round((Date.now() - startedAt) / 1000)}s`);
  } catch (err) {
    console.error(err);
    await alertError(store, telegram, config, err);
    process.exitCode = 1;
  }
}

main();
