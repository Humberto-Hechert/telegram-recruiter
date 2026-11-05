// Acesso ao Cloudflare Workers KV pela API REST (o GitHub Actions não roda dentro da Cloudflare).
// O Worker do botão acessa o MESMO namespace, mas pelo binding nativo `env.JOBS`.

export function createCloudflareKv({ accountId, namespaceId, apiToken }, { fetchImpl = fetch } = {}) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}`;
  const headers = { Authorization: `Bearer ${apiToken}` };

  async function check(res, action) {
    if (res.ok) return;
    const body = await res.text().catch(() => '');
    throw new Error(`Cloudflare KV (${action}) HTTP ${res.status}: ${body.slice(0, 300)}`);
  }

  return {
    async get(key) {
      const res = await fetchImpl(`${base}/values/${encodeURIComponent(key)}`, { headers });
      if (res.status === 404) return null;
      await check(res, `get ${key}`);
      const text = await res.text();
      try { return JSON.parse(text); } catch { return text; }
    },
    async put(key, value, { ttlSeconds } = {}) {
      const qs = ttlSeconds ? `?expiration_ttl=${Math.max(60, Math.round(ttlSeconds))}` : '';
      const res = await fetchImpl(`${base}/values/${encodeURIComponent(key)}${qs}`, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'text/plain' },
        body: JSON.stringify(value),
      });
      await check(res, `put ${key}`);
    },
    async list(prefix) {
      const names = [];
      let cursor;
      do {
        const qs = new URLSearchParams({ prefix, limit: '1000', ...(cursor ? { cursor } : {}) });
        const res = await fetchImpl(`${base}/keys?${qs}`, { headers });
        await check(res, `list ${prefix}`);
        const data = await res.json();
        names.push(...(data.result || []).map((k) => k.name));
        cursor = data.result_info?.cursor || undefined;
      } while (cursor);
      return names;
    },
  };
}

/** KV em memória: usado nos testes e no DRY_RUN sem credenciais da Cloudflare. */
export function createMemoryKv() {
  const data = new Map();
  return {
    data,
    async get(key) { return data.has(key) ? structuredClone(data.get(key)) : null; },
    async put(key, value) { data.set(key, structuredClone(value)); },
    async list(prefix) { return [...data.keys()].filter((k) => k.startsWith(prefix)); },
  };
}

/** Embrulha um KV para só ler (DRY_RUN com credenciais reais não escreve nada). */
export function readOnly(kv, log = console.log) {
  return {
    ...kv,
    async put(key) { log(`  [dry-run] não gravou ${key}`); },
  };
}
