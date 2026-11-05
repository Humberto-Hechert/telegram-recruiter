// Do card de vaga até a mensagem no Telegram:
// pré-filtro → deduplicação → detalhe → LLM → nota → piso salarial → enviar / digest / descartar.
import { BlockedError } from './linkedin.js';
import { evaluateJob, computeScore, classify } from './scoring.js';
import { passesFloor, formatSalary } from './salary.js';
import { formatJobMessage, jobButtons } from './telegram.js';
import { fingerprint, truncate } from './util.js';

const MAX_CONSECUTIVE_LLM_ERRORS = 3;

export async function processJobs(jobs, ctx) {
  const { config, profile, store, prefilter, complete, telegram, fetchDetail, getRates, today, log = console.log, logJobs = false } = ctx;
  const stats = { recebidas: jobs.length, prefiltradas: 0, repetidas: 0, avaliadas: 0, enviadas: 0, quase: 0, descartadas: 0, adiadas: 0, erros: 0, bloqueio: null };

  // 1) Filtros baratos: nada de rede além de uma leitura no KV.
  const seenInRun = new Set();
  const candidates = [];
  for (const job of jobs) {
    if (!prefilter(job).ok) { stats.prefiltradas++; continue; }
    const fp = fingerprint(job.company, job.title);
    if (seenInRun.has(fp) || (await store.isSeen(fp))) { stats.repetidas++; continue; }
    seenInRun.add(fp);
    candidates.push({ job, fp });
  }

  const batch = candidates.slice(0, config.llm.maxEvaluationsPerRun);
  stats.adiadas = candidates.length - batch.length; // ficam para a próxima execução
  if (!complete) {
    log(`${batch.length} vagas novas, mas nenhum LLM configurado: nada foi avaliado`);
    stats.adiadas = candidates.length;
    return stats;
  }

  // 2) Avaliação, uma vaga por vez (respeitando o limite por minuto do LLM).
  let consecutiveErrors = 0;
  for (let i = 0; i < batch.length; i++) {
    const { job, fp } = batch[i];
    try {
      if (!job.description) {
        const detail = await fetchDetail(job.id);
        if (detail) Object.assign(job, { description: detail.description, criteria: detail.criteria, salaryText: detail.salaryText });
      }

      const { evaluation, provider } = await evaluateJob(complete, profile, job, config.llm);
      consecutiveErrors = 0;
      const score = computeScore(evaluation, config.scoring.weights);
      const informed = evaluation.salario_informado || null;
      const floorOk = passesFloor(informed, await getRates(), config.salary);
      const status = classify({ score, eliminated: evaluation.eliminada, floorOk }, config.scoring);
      stats.avaliadas++;

      const record = {
        id: job.id, title: job.title, company: job.company, url: job.url,
        score, status, provider, evaluatedAt: new Date().toISOString(),
        ...(evaluation.eliminada ? { motivo: evaluation.motivo_eliminacao } : {}),
      };

      if (status === 'enviada') {
        const salaryText = informed ? formatSalary(informed, false) : formatSalary(evaluation.salario_estimado, true);
        await telegram.sendMessage(formatJobMessage({ job, evaluation, score, salaryText }), { buttons: jobButtons(job, fp) });
        Object.assign(record, {
          location: evaluation.local_resumo || job.location,
          idioma: evaluation.idioma_vaga || 'pt',
          description: truncate(job.description || '', 5000),
        });
        stats.enviadas++;
      } else if (status === 'quase') {
        await store.saveNearMiss(today, fp, {
          title: job.title, company: job.company, url: job.url, score,
          local: evaluation.local_resumo || job.location,
          motivo: evaluation.ponto_de_atencao || evaluation.por_que_combina || '',
        });
        stats.quase++;
      } else {
        stats.descartadas++;
      }

      // Marcar como vista só depois de enviar: se o Telegram falhar, a vaga é tentada de novo.
      await store.saveJob(fp, record);
      if (logJobs) log(`  ${String(score).padStart(3)}% [${status}] ${job.title} @ ${job.company}`);
    } catch (err) {
      if (err instanceof BlockedError) {
        stats.bloqueio = err.message;
        stats.adiadas += batch.length - i;
        break;
      }
      stats.erros++;
      consecutiveErrors++;
      log(`  ! erro ao processar vaga ${job.id}: ${err.message}`);
      if (consecutiveErrors >= MAX_CONSECUTIVE_LLM_ERRORS) {
        log('  ! muitos erros seguidos (provável cota de LLM esgotada): parando esta execução');
        stats.adiadas += batch.length - i - 1;
        break;
      }
    }
  }
  return stats;
}
