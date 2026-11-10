// Decide de onde vêm as vagas nesta execução: LinkedIn direto (guest) ou Apify (reserva).
//
//   guest ──(bloqueio)──► apify (a cada `apify.intervalMinutes`) ──(probe ok, após a espera)──► guest
//
// O probe é uma requisição só e passa com facilidade, mas a busca completa (dezenas de
// requisições) volta a levar 429. Para não alternar a cada 15 min:
//   - depois de um bloqueio, só testa o LinkedIn de novo após uma espera que dobra a cada
//     nova tentativa frustrada (`apify.guestRetryMinutes` → até `apify.guestRetryMaxMinutes`);
//   - avisa "voltou" só quando uma busca COMPLETA dá certo;
//   - se a tentativa de volta for bloqueada, não avisa de novo (só aumenta a espera).
import { BlockedError } from './linkedin.js';

function backoffMinutes(apifyConfig, failures) {
  const base = apifyConfig.guestRetryMinutes ?? 60;
  const max = apifyConfig.guestRetryMaxMinutes ?? 720;
  return Math.min(base * 2 ** Math.max(0, failures - 1), max);
}

/**
 * Troca para o Apify. `prev` é o modo em que o bloqueio aconteceu: se era uma tentativa de
 * volta (`recovering`), não manda aviso de novo, só aumenta a espera.
 */
export async function switchToApify(store, notify, reason, now, { prev = {}, apifyConfig = {} } = {}) {
  const failures = prev.recovering ? (prev.failures || 1) + 1 : 1;
  const waitMin = backoffMinutes(apifyConfig, failures);
  const mode = { source: 'apify', since: prev.recovering ? prev.blockedSince || now : now, blockedSince: prev.recovering ? prev.blockedSince || now : now, lastApifyRun: 0, failures, retryAt: now + waitMin * 60000 };
  await store.setState('mode', mode);
  if (!prev.recovering) {
    await notify(`⚠️ O LinkedIn bloqueou a busca direta (${reason}). Vou usar o Apify a cada 2h e avisar quando o LinkedIn voltar.`);
  }
  return mode;
}

/** Tentativa de volta deu certo do começo ao fim (busca + detalhes): fixa o modo guest e avisa. */
export async function confirmGuest(store, notify, mode, now) {
  if (!mode?.recovering) return;
  await store.setState('mode', { source: 'guest', since: now });
  await notify('✅ O LinkedIn voltou a responder. Voltei para a busca direta a cada 15 min.');
}

export async function collectJobs({ config, env, store, notify, now = Date.now(), linkedin, apify, log = console.log }) {
  const initialized = await store.getState('initialized');
  const firstRun = !initialized;
  const windowSeconds = firstRun ? config.search.firstRunWindowSeconds : config.search.windowSeconds;
  let mode = (await store.getState('mode')) || { source: 'guest' };

  if (mode.source === 'apify') {
    if (now < (mode.retryAt || 0)) {
      log(`Modo Apify: próximo teste do LinkedIn em ${Math.ceil((mode.retryAt - now) / 60000)} min`);
    } else if (await linkedin.probe(config.search)) {
      // Tenta a busca completa; o aviso de "voltou" só sai se ela passar inteira.
      mode = { source: 'guest', recovering: true, failures: mode.failures || 1, blockedSince: mode.blockedSince || mode.since, lastApifyRun: mode.lastApifyRun || 0 };
      await store.setState('mode', mode);
      log('LinkedIn respondeu ao probe: tentando a busca direta');
    } else {
      mode = await switchToApify(store, notify, 'probe', now, { prev: { ...mode, recovering: true }, apifyConfig: config.apify });
      log(`Probe falhou: próximo teste em ${Math.round((mode.retryAt - now) / 60000)} min`);
    }
  }

  if (mode.source === 'guest') {
    try {
      const jobs = await linkedin.searchAll(config.search, windowSeconds);
      // Em tentativa de volta, quem confirma (e avisa) é o chamador, depois de buscar os detalhes sem bloqueio.
      return { jobs, source: 'guest', firstRun, mode };
    } catch (err) {
      if (!(err instanceof BlockedError)) throw err;
      const prevLastApifyRun = mode.lastApifyRun || 0;
      mode = await switchToApify(store, notify, err.message, now, { prev: mode, apifyConfig: config.apify });
      // Numa tentativa de volta frustrada, mantém o relógio do Apify (não roda Apify fora de hora).
      if (prevLastApifyRun) { mode.lastApifyRun = prevLastApifyRun; await store.setState('mode', mode); }
      log(`LinkedIn bloqueou: ${err.message} (${err.partial.length} vagas coletadas antes); próximo teste em ${Math.round((mode.retryAt - now) / 60000)} min`);
      if (err.partial.length) return { jobs: err.partial, source: 'guest-parcial', firstRun };
    }
  }

  // Modo Apify
  if (!env.apifyToken) {
    log('Modo Apify, mas APIFY_TOKEN não está configurado: nada a buscar nesta execução');
    return { jobs: [], source: 'sem-fonte', firstRun };
  }
  const elapsedMin = (now - (mode.lastApifyRun || 0)) / 60000;
  if (elapsedMin < config.apify.intervalMinutes) {
    log(`Modo Apify: próxima busca em ${Math.ceil(config.apify.intervalMinutes - elapsedMin)} min`);
    return { jobs: [], source: 'apify-aguardando', firstRun };
  }
  const apifyWindow = Math.max(windowSeconds, config.apify.windowSeconds);
  const jobs = await apify.searchApify(config.search, config.apify, env.apifyToken, apifyWindow);
  await store.setState('mode', { ...mode, lastApifyRun: now });
  return { jobs, source: 'apify', firstRun };
}
