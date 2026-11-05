// Chaves usadas no Cloudflare KV. O Worker (worker/src/index.js) lê as mesmas chaves.
//
//   vaga:<fingerprint>          vaga já avaliada (qualquer resultado). Expira em `dedupDays`.
//                               Para vagas enviadas guarda também a descrição, usada pela carta.
//   quase:<AAAA-MM-DD>:<fp>     vaga entre 60 e 69% para o digest daquele dia. Expira em 3 dias.
//   state:mode                  fonte atual: { source: 'guest' | 'apify', since, lastApifyRun }
//   state:initialized           existe depois da primeira execução (que varre 24h)
//   state:lastErrorAlert        quando o último alerta de erro foi enviado (evita spam)

const DAY = 86400;

export function createStore(kv, { dedupDays }) {
  return {
    async isSeen(fp) {
      return (await kv.get(`vaga:${fp}`)) !== null;
    },
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
