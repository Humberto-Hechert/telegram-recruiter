// Monta as dependências compartilhadas entre a busca (scan.js) e o digest (digest.js).
import { loadConfig } from './config.js';
import { createCloudflareKv, createMemoryKv, readOnly } from './kv.js';
import { createStore } from './store.js';
import { createTelegram } from './telegram.js';

export function buildContext(env, log = console.log) {
  const config = loadConfig();
  const hasCloudflare = env.cfAccountId && env.cfNamespaceId && env.cfApiToken;
  let kv = hasCloudflare
    ? createCloudflareKv({ accountId: env.cfAccountId, namespaceId: env.cfNamespaceId, apiToken: env.cfApiToken })
    : createMemoryKv();
  if (env.dryRun && hasCloudflare) kv = readOnly(kv, log);
  if (!hasCloudflare) log('Sem credenciais da Cloudflare: usando armazenamento em memória (nada fica salvo)');
  const store = createStore(kv, { ...config.storage, timeZone: config.timezone });
  const telegram = createTelegram({ token: env.telegramToken, chatId: env.telegramChatId, dryRun: env.dryRun }, { log });
  return { config, store, telegram };
}
