// Decide de onde vêm as vagas nesta execução: LinkedIn direto (guest) ou Apify (reserva).
//
//   guest ──(bloqueio)──► apify (a cada `apify.intervalMinutes`) ──(probe ok)──► guest
//
// Cada troca de modo gera um aviso no Telegram. Execuções no meio do intervalo do Apify
// só fazem o "probe" e terminam sem buscar nada.
import { BlockedError } from './linkedin.js';

export async function switchToApify(store, notify, reason, now) {
  await store.setState('mode', { source: 'apify', since: now, lastApifyRun: 0 });
  await notify(`⚠️ O LinkedIn bloqueou a busca direta (${reason}). Vou usar o Apify a cada 2h e avisar quando o LinkedIn voltar.`);
}

export async function collectJobs({ config, env, store, notify, now = Date.now(), linkedin, apify, log = console.log }) {
  const initialized = await store.getState('initialized');
  const firstRun = !initialized;
  const windowSeconds = firstRun ? config.search.firstRunWindowSeconds : config.search.windowSeconds;
  let mode = (await store.getState('mode')) || { source: 'guest' };

  if (mode.source === 'apify' && (await linkedin.probe(config.search))) {
    mode = { source: 'guest', since: now };
    await store.setState('mode', mode);
    await notify('✅ O LinkedIn voltou a responder. Voltei para a busca direta a cada 15 min.');
    log('LinkedIn respondeu ao probe: voltando para o modo guest');
  }

  if (mode.source === 'guest') {
    try {
      const jobs = await linkedin.searchAll(config.search, windowSeconds);
      return { jobs, source: 'guest', firstRun };
    } catch (err) {
      if (!(err instanceof BlockedError)) throw err;
      log(`LinkedIn bloqueou: ${err.message} (${err.partial.length} vagas coletadas antes)`);
      await switchToApify(store, notify, err.message, now);
      mode = { source: 'apify', since: now, lastApifyRun: 0 };
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
