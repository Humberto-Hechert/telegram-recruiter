import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function loadConfig() {
  return JSON.parse(readFileSync(join(ROOT, 'config', 'config.json'), 'utf8'));
}

export function loadProfile() {
  return readFileSync(join(ROOT, 'perfil.md'), 'utf8');
}

/**
 * Lê as variáveis de ambiente (no GitHub Actions elas vêm dos Secrets).
 * Em DRY_RUN, nada é obrigatório: sem Cloudflare usa memória, sem Telegram imprime no console.
 */
export function loadEnv(env = process.env) {
  const dryRun = env.DRY_RUN === '1' || env.DRY_RUN === 'true';
  const values = {
    dryRun,
    logJobs: env.LOG_JOBS === '1',
    telegramToken: env.TELEGRAM_BOT_TOKEN,
    telegramChatId: env.TELEGRAM_CHAT_ID,
    cfAccountId: env.CF_ACCOUNT_ID,
    cfNamespaceId: env.CF_KV_NAMESPACE_ID,
    cfApiToken: env.CF_API_TOKEN,
    geminiKey: env.GEMINI_API_KEY,
    geminiModel: env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
    groqKey: env.GROQ_API_KEY,
    groqModel: env.GROQ_MODEL || 'openai/gpt-oss-120b',
    openaiKey: env.OPENAI_API_KEY,
    openaiModel: env.OPENAI_MODEL || '',
    apifyToken: env.APIFY_TOKEN,
  };

  if (!dryRun) {
    const required = {
      TELEGRAM_BOT_TOKEN: values.telegramToken,
      TELEGRAM_CHAT_ID: values.telegramChatId,
      CF_ACCOUNT_ID: values.cfAccountId,
      CF_KV_NAMESPACE_ID: values.cfNamespaceId,
      CF_API_TOKEN: values.cfApiToken,
    };
    const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
    if (!values.geminiKey && !values.groqKey && !values.openaiKey) missing.push('GEMINI_API_KEY, GROQ_API_KEY ou OPENAI_API_KEY');
    if (missing.length) throw new Error(`Variáveis de ambiente faltando: ${missing.join(', ')}`);
  }
  return values;
}
