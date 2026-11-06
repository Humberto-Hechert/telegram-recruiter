// Avaliação de compatibilidade vaga × perfil.
// O LLM dá notas por critério; a nota final e a classificação são calculadas aqui, em código,
// para que a régua seja sempre a mesma (o LLM não decide o corte de 70%).
import { parseJsonResponse } from './llm.js';
import { truncate } from './util.js';

export const SYSTEM_PROMPT = `Você é um recrutador técnico sênior avaliando se uma vaga combina com um candidato.
Seja rigoroso e honesto: não infle notas. Responda SOMENTE com JSON válido no formato pedido.`;

export function buildEvaluationPrompt(profile, job, maxDescriptionChars) {
  const criteria = Object.entries(job.criteria || {})
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');

  return `## PERFIL DO CANDIDATO
${profile}

## VAGA
Título: ${job.title}
Empresa: ${job.company}
Local: ${job.location}
${criteria ? `Critérios do LinkedIn:\n${criteria}\n` : ''}${job.salaryHint || job.salaryText ? `Salário exibido no LinkedIn: ${job.salaryText || job.salaryHint}\n` : ''}
Descrição:
${truncate(job.description || '(sem descrição)', maxDescriptionChars)}

## COMO AVALIAR

1) ELIMINATÓRIOS — se QUALQUER um valer, "eliminada": true:
- Exige residência, cidadania, visto ou autorização de trabalho em país que não seja o Brasil (ex.: "must be based in the US", "US only", "must reside in Portugal", "EU work authorization"). O candidato mora em São Paulo: vagas remotas de empresas dos EUA ou de Portugal só passam se aceitarem profissional morando no Brasil (contractor/PJ internacional, "remote LATAM", "worldwide/anywhere"). Vagas "remote Brazil" NÃO são eliminadas por isso.
- Trabalho presencial ou híbrido FORA da Grande São Paulo. (Presencial ou híbrido NA Grande São Paulo é aceito.)
- Stack principal totalmente alheia ao candidato (ex.: só Java, .NET, PHP, mobile nativo, SAP, front-end puro), sem back-end/IA relevante.
- Senioridade incompatível: júnior/estágio, ou staff/principal/diretoria exigindo muito mais experiência que a do candidato.

2) NOTAS de 0 a 100 (mesmo se eliminada, preencha):
- stack: aderência das tecnologias pedidas (Node.js, AWS, APIs REST, SQL, LLMs, RAG, OpenAI API, MongoDB, integrações) ao que o candidato usa.
- tipo_trabalho: aderência ao tipo de trabalho (back-end, agentes de IA, plataformas conversacionais, integrações com CRM/ERP).
- experiencia: anos e nível pedidos versus a experiência real do candidato.
- outros: idioma, domínio de negócio, requisitos extras (ex.: Python obrigatório, liderança, certificações).

3) SALÁRIO:
- "salario_informado": só se a vaga (descrição ou campo de salário) informar valor. Caso contrário null.
- "salario_estimado": SEMPRE preencha com uma estimativa realista para essa vaga e esse perfil, na moeda e no tipo de contrato mais prováveis.
- "periodo": "hora", "mes" ou "ano". "contrato": "CLT", "PJ", "contractor" ou "indefinido".

## FORMATO DA RESPOSTA (JSON)
{
  "eliminada": boolean,
  "motivo_eliminacao": string | null,
  "notas": { "stack": number, "tipo_trabalho": number, "experiencia": number, "outros": number },
  "resumo": "2 a 3 linhas em português: o que a empresa faz e o que a vaga pede",
  "por_que_combina": "1 linha em português",
  "ponto_de_atencao": "1 linha em português com o principal risco ou lacuna, ou null",
  "local_resumo": "ex.: Remoto (LATAM), Remoto (Brasil), Híbrido (São Paulo)",
  "idioma_vaga": "pt" | "en" | "es" | "outro",
  "salario_informado": null | { "min": number|null, "max": number|null, "moeda": "BRL"|"USD"|"EUR"|..., "periodo": "hora"|"mes"|"ano", "contrato": "CLT"|"PJ"|"contractor"|"indefinido" },
  "salario_estimado": { "min": number, "max": number, "moeda": string, "periodo": "hora"|"mes"|"ano", "contrato": string }
}`;
}

const clamp = (n) => Math.max(0, Math.min(100, Number(n) || 0));

/** Nota final ponderada (0–100). Eliminada = 0. */
export function computeScore(evaluation, weights) {
  if (evaluation.eliminada) return 0;
  const notas = evaluation.notas || {};
  let total = 0;
  let weightSum = 0;
  for (const [criterion, weight] of Object.entries(weights)) {
    total += clamp(notas[criterion]) * weight;
    weightSum += weight;
  }
  return Math.round(total / (weightSum || 1));
}

/** Decide o destino da vaga: enviada agora, digest diário ou descartada. */
export function classify({ score, eliminated, floorOk }, scoringConfig) {
  if (eliminated) return 'eliminada';
  if (!floorOk) return 'abaixo_do_piso';
  if (score >= scoringConfig.sendThreshold) return 'enviada';
  if (score >= scoringConfig.digestThreshold) return 'quase';
  return 'baixa';
}

export async function evaluateJob(complete, profile, job, llmConfig) {
  const { text, provider } = await complete({
    system: SYSTEM_PROMPT,
    user: buildEvaluationPrompt(profile, job, llmConfig.maxDescriptionChars),
    json: true,
  });
  const evaluation = parseJsonResponse(text);
  if (typeof evaluation.eliminada !== 'boolean' || typeof evaluation.notas !== 'object') {
    throw new Error('JSON do LLM fora do formato esperado');
  }
  return { evaluation, provider };
}
