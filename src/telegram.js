// Envio de mensagens para o Telegram (parse_mode HTML).
import { escapeHtml, truncate } from './util.js';

const LIMIT = 4096;

export function createTelegram({ token, chatId, dryRun }, { fetchImpl = fetch, log = console.log } = {}) {
  async function sendMessage(text, { buttons } = {}) {
    if (dryRun || !token) {
      log(`\n----- [dry-run] mensagem do Telegram -----\n${text}\n${buttons ? `[botões: ${buttons.flat().map((b) => b.text).join(' | ')}]` : ''}\n-----`);
      return;
    }
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: truncate(text, LIMIT - 1),
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
      }),
    });
    if (!res.ok) throw new Error(`Telegram HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  /** Divide textos longos (digest) em várias mensagens, quebrando entre blocos. */
  async function sendLong(blocks, header) {
    let current = header;
    for (const block of blocks) {
      if ((current + '\n\n' + block).length > LIMIT - 50) {
        await sendMessage(current);
        current = block;
      } else {
        current += `\n\n${block}`;
      }
    }
    if (current) await sendMessage(current);
  }

  return { sendMessage, sendLong };
}

const scoreEmoji = (score) => (score >= 85 ? '🟢' : '🟡');

/** Mensagem de vaga compatível (formato combinado na Q11). */
export function formatJobMessage({ job, evaluation, score, salaryText }) {
  const lines = [
    `${scoreEmoji(score)} <b>${score}%</b> · <a href="${job.url}"><b>${escapeHtml(job.title)}</b></a>`,
    `🏢 ${escapeHtml(job.company || '—')} · 🌎 ${escapeHtml(evaluation.local_resumo || job.location || '—')}`,
    `💰 ${escapeHtml(salaryText)}`,
    '',
    `📝 <b>Resumo:</b> ${escapeHtml(evaluation.resumo || '—')}`,
    `✅ <b>Por que combina:</b> ${escapeHtml(evaluation.por_que_combina || '—')}`,
  ];
  if (evaluation.ponto_de_atencao) lines.push(`⚠️ <b>Ponto de atenção:</b> ${escapeHtml(evaluation.ponto_de_atencao)}`);
  return lines.join('\n');
}

export function jobButtons(job, fp) {
  return [[
    { text: '🔗 Ver vaga', url: job.url },
    { text: '✉️ Gerar carta', callback_data: `carta:${fp}` },
  ]];
}

/** Um bloco por vaga do digest diário (60–69%). */
export function formatDigestItem(item) {
  return [
    `🟠 <b>${item.score}%</b> · <a href="${item.url}">${escapeHtml(item.title)}</a>`,
    `🏢 ${escapeHtml(item.company || '—')} · 🌎 ${escapeHtml(item.local || '—')}`,
    `↳ ${escapeHtml(item.motivo || '')}`,
  ].join('\n');
}
