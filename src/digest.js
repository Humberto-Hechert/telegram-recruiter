// Digest diário (18h de São Paulo): uma mensagem com as vagas "quase" (60–69%) do dia.
import { loadEnv } from './config.js';
import { buildContext } from './context.js';
import { formatDigestItem } from './telegram.js';
import { dateInTimezone } from './util.js';

async function main() {
  const env = loadEnv();
  const { config, store, telegram } = buildContext(env);
  const today = dateInTimezone(new Date(), config.timezone);

  // O digest pode ser disparado pelo cron-job.org e pelo agendamento reserva: só sai uma vez por dia.
  if (await store.getState(`digest:${today}`)) {
    console.log(`Digest de ${today} já foi enviado`);
    return;
  }

  const items = (await store.listNearMisses(today)).sort((a, b) => b.score - a.score);
  console.log(`Digest de ${today}: ${items.length} vagas "quase"`);

  if (items.length) {
    const [, month, day] = today.split('-');
    const header = `📋 <b>Quase lá — ${day}/${month}</b>\n${items.length} vaga(s) entre ${config.scoring.digestThreshold}% e ${config.scoring.sendThreshold - 1}% hoje. Se você aplicaria em várias, a régua está rígida demais.`;
    await telegram.sendLong(items.map(formatDigestItem), header);
  }
  await store.setState(`digest:${today}`, true, 2 * 86400);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
