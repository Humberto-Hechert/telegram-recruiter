// Chaves usadas no Cloudflare KV. O Worker (worker/src/index.js) lê as mesmas chaves.
//
//   vistas:<AAAA-MM-DD>         lista de fingerprints avaliados naquele dia (qualquer resultado).
//                               UMA gravação por execução, em vez de uma por vaga (o plano grátis
//                               do KV permite só 1.000 gravações por dia). Expira em `dedupDays` + 1.
//   vaga:<fingerprint>          registro completo, só das vagas ENVIADAS (o botão de carta lê daqui).
//                               Expira em `dedupDays`. Registros antigos de qualquer status ainda contam
//                               como "vista" até expirarem.
//   quase:<AAAA-MM-DD>:<fp>     vaga entre 60 e 69% para o digest daquele dia. Expira em 3 dias.
//   state:mode                  fonte atual: { source: 'guest' | 'apify', since, lastApifyRun }
//   state:initialized           existe depois da primeira execução (que varre 24h)
//   state:lastErrorAlert        quando o último alerta de erro foi enviado (evita spam)
//   state:openai:<AAAA-MM>      gasto do mês com a OpenAI (budget.js)
import { dateInTimezone } from './util.js';

const DAY = 86400;

export function createStore(kv, { dedupDays, timeZone = 'America/Sao_Paulo' }, { now = () => new Date() } = {}) {
  // Índice de vagas vistas: carregado uma vez por execução, gravado uma vez no fim.
  let seen = null;              // Set com tudo dos últimos `dedupDays` dias
  const buckets = new Map();    // chave vistas:<data> → Set (o que já estava gravado)
  const pending = new Set();    // vistas nesta execução, ainda não gravadas

  function bucketKeys() {
    const keys = new Set();
    const t = now().getTime();
    for (let i = 0; i < dedupDays; i++) keys.add(`vistas:${dateInTimezone(new Date(t - i * DAY * 1000), timeZone)}`);
    return [...keys];
  }

  async function loadSeen() {
    if (seen) return;
    seen = new Set();
    for (const key of bucketKeys()) {
      const value = await kv.get(key);
      const set = new Set(Array.isArray(value) ? value : []);
      buckets.set(key, set);
      for (const fp of set) seen.add(fp);
    }
  }

  return {
    async isSeen(fp) {
      await loadSeen();
      if (seen.has(fp) || pending.has(fp)) return true;
      return (await kv.get(`vaga:${fp}`)) !== null; // registros antigos / vagas enviadas
    },
    /** Marca como vista. Só vai para o KV no `flushSeen()` do fim da execução. */
    markSeen(fp) {
      pending.add(fp);
    },
    get pendingSeen() {
      return pending.size;
    },
    /** Grava as vagas vistas nesta execução no balde do dia (1 gravação). */
    async flushSeen() {
      if (!pending.size) return;
      await loadSeen();
      const key = `vistas:${dateInTimezone(now(), timeZone)}`;
      const bucket = buckets.get(key) ?? new Set(await kv.get(key) || []);
      for (const fp of pending) bucket.add(fp);
      await kv.put(key, [...bucket], { ttlSeconds: (dedupDays + 1) * DAY });
      buckets.set(key, bucket);
      for (const fp of pending) seen.add(fp);
      pending.clear();
    },
    /** Registro completo de uma vaga enviada (usado pelo botão de carta). */
    async saveJob(fp, record) {
      await kv.put(`vaga:${fp}`, record, { ttlSeconds: dedupDays * DAY });
    },
    async saveNearMiss(date, fp, record) {
      await kv.put(`quase:${date}:${fp}`, record, { ttlSeconds: 3 * DAY });
    },
    async listNearMisses(date) {
      const keys = await kv.list(`quase:${date}:`);
      const items = [];
      for (const key of keys) {
        const value = await kv.get(key);
        if (value) items.push(value);
      }
      return items;
    },
    async getState(name) {
      return kv.get(`state:${name}`);
    },
    async setState(name, value, ttlSeconds) {
      await kv.put(`state:${name}`, value, ttlSeconds ? { ttlSeconds } : {});
    },
  };
}
