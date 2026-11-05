// Cloudflare Worker: recebe os cliques do Telegram (webhook) e gera a carta de apresentação.
//
// Fluxo do botão "✉️ Gerar carta":
//   Telegram → POST deste Worker (callback_query "carta:<fp>")
//   → lê a vaga em KV (chave vaga:<fp>, gravada pelo robô no GitHub Actions)
//   → lê o perfil (perfil.md no repositório público) → LLM → responde a mensagem da vaga com a carta.
//
// Comandos aceitos: /start (mostra o chat ID se ALLOWED_CHAT_ID ainda não estiver configurado) e /status.

const LETTER_SYSTEM = `Você escreve cartas de apresentação curtas, específicas e sem clichês para candidaturas de emprego.
Nunca invente experiências, números ou tecnologias que não estejam no perfil.`;

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') return new Response('telegram-recruiter worker ok');
    if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.TELEGRAM_WEBHOOK_SECRET) {
      return new Response('unauthorized', { status: 401 });
    }
    const update = await request.json().catch(() => null);
    // Responde 200 na hora para o Telegram não reenviar; o trabalho continua em segundo plano.
    if (update) ctx.waitUntil(handleUpdate(update, env).catch((err) => console.error('erro no update', err)));
    return new Response('ok');
  },
};

async function handleUpdate(update, env) {
  if (update.callback_query) return handleCallback(update.callback_query, env);
  if (update.message?.text) return handleMessage(update.message, env);
}

const isAllowed = (chatId, env) => env.ALLOWED_CHAT_ID && String(chatId) === String(env.ALLOWED_CHAT_ID);

async function handleMessage(message, env) {
  const chatId = message.chat.id;
  const text = message.text.trim();

  if (text.startsWith('/start') || text.startsWith('/id')) {
    if (!env.ALLOWED_CHAT_ID) {
      return tg(env, 'sendMessage', { chat_id: chatId, text: `Seu chat ID é ${chatId}. Coloque esse número em ALLOWED_CHAT_ID (Worker) e TELEGRAM_CHAT_ID (GitHub).` });
    }
    if (isAllowed(chatId, env)) {
      return tg(env, 'sendMessage', { chat_id: chatId, text: 'Robô de vagas ativo ✅\nComandos: /status' });
    }
    return; // desconhecido: ignora em silêncio
  }

  if (text.startsWith('/status') && isAllowed(chatId, env)) {
    const mode = await env.JOBS.get('state:mode', 'json');
    const initialized = await env.JOBS.get('state:initialized', 'json');
    const source = !mode || mode.source === 'guest' ? 'LinkedIn direto (a cada 15 min)' : 'Apify (a cada 2h, LinkedIn bloqueado)';
    const since = mode?.since ? ` desde ${new Date(mode.since).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}` : '';
    return tg(env, 'sendMessage', {
      chat_id: chatId,
      text: `Fonte atual: ${source}${since}\nPrimeira execução: ${initialized ? new Date(initialized).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : 'ainda não rodou'}`,
    });
  }
}

async function handleCallback(cq, env) {
  const chatId = cq.message?.chat?.id;
  if (!isAllowed(chatId, env)) {
    return tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'Não autorizado.' });
  }
  if (!cq.data?.startsWith('carta:')) {
    return tg(env, 'answerCallbackQuery', { callback_query_id: cq.id });
  }

  const fp = cq.data.slice('carta:'.length);
  await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'Gerando a carta… ✍️' });
  const replyTo = { reply_parameters: { message_id: cq.message.message_id, allow_sending_without_reply: true } };

  const job = await env.JOBS.get(`vaga:${fp}`, 'json');
  if (!job) {
    return tg(env, 'sendMessage', { chat_id: chatId, text: 'Não encontrei os dados dessa vaga (eles expiram depois de 30 dias).', ...replyTo });
  }

  let letter = job.carta;
  if (!letter) {
    try {
      const profile = await fetchProfile(env);
      letter = (await complete(env, LETTER_SYSTEM, buildLetterPrompt(profile, job))).trim();
      await cacheLetter(env, fp, job, letter);
    } catch (err) {
      console.error(err);
      return tg(env, 'sendMessage', { chat_id: chatId, text: `Não consegui gerar a carta agora: ${err.message}`, ...replyTo });
    }
  }

  return tg(env, 'sendMessage', {
    chat_id: chatId,
    parse_mode: 'HTML',
    text: `✉️ <b>Carta — ${escapeHtml(job.title)} @ ${escapeHtml(job.company)}</b>\n\n${escapeHtml(letter)}`.slice(0, 4090),
    ...replyTo,
  });
}

function buildLetterPrompt(profile, job) {
  const language = job.idioma === 'en' ? 'inglês' : job.idioma === 'es' ? 'espanhol' : 'português do Brasil';
  return `## PERFIL DO CANDIDATO
${profile}

## VAGA
Título: ${job.title}
Empresa: ${job.company}
Local: ${job.location || ''}
Descrição:
${job.description || '(sem descrição)'}

## TAREFA
Escreva uma carta de apresentação em ${language} para essa vaga, em primeira pessoa.
- 150 a 220 palavras, 3 parágrafos curtos.
- Conecte 2 ou 3 resultados concretos do perfil (com os números que estão lá) ao que a vaga pede.
- Nada de frases genéricas ("sou apaixonado por tecnologia"), nada de placeholders entre colchetes.
- Termine com o nome do candidato.
- Responda só com o texto da carta, sem markdown.`;
}

async function fetchProfile(env) {
  const res = await fetch(env.PROFILE_URL, { cf: { cacheTtl: 300 } });
  if (!res.ok) throw new Error(`não consegui ler o perfil (HTTP ${res.status})`);
  return res.text();
}

/** Guarda a carta junto da vaga, preservando o tempo de expiração original do registro. */
async function cacheLetter(env, fp, job, letter) {
  const dedupDays = Number(env.DEDUP_DAYS || 30);
  const ageSeconds = (Date.now() - Date.parse(job.evaluatedAt || Date.now())) / 1000;
  const ttl = Math.max(60, Math.round(dedupDays * 86400 - ageSeconds));
  await env.JOBS.put(`vaga:${fp}`, JSON.stringify({ ...job, carta: letter }), { expirationTtl: ttl });
}

async function complete(env, system, user) {
  const errors = [];
  if (env.GEMINI_API_KEY) {
    try {
      const model = env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: { temperature: 0.6 },
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('');
      if (text) return text;
      throw new Error('resposta vazia');
    } catch (err) {
      errors.push(`Gemini: ${err.message}`);
    }
  }
  if (env.GROQ_API_KEY) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.GROQ_API_KEY}` },
        body: JSON.stringify({
          model: env.GROQ_MODEL || 'openai/gpt-oss-120b',
          temperature: 0.6,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content;
      if (text) return text;
      throw new Error('resposta vazia');
    } catch (err) {
      errors.push(`Groq: ${err.message}`);
    }
  }
  throw new Error(errors.join(' | ') || 'nenhuma chave de LLM configurada');
}

async function tg(env, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) console.error(`Telegram ${method} HTTP ${res.status}: ${await res.text()}`);
  return res;
}

function escapeHtml(text = '') {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
