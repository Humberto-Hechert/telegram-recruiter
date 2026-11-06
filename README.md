# telegram-recruiter

Robô que procura vagas novas no LinkedIn a cada 15 minutos, usa IA para medir o quanto cada uma combina com o meu perfil e manda no Telegram só as que passam de 70%, com título, resumo, remuneração e link. Um botão na mensagem gera a carta de apresentação para a vaga.

**Custo: R$ 0.** O robô roda em GitHub Actions + cron-job.org, usa o LinkedIn (endpoint guest) com Apify de reserva, avalia com Gemini/Groq (free tier) e guarda o estado em Cloudflare Workers KV + Worker.

```
🟢 87% · Senior Backend Engineer (Node.js)
🏢 Acme · 🌎 Remoto (LATAM)
💰 US$ 4.000–5.500/mês (contractor) (estimativa IA)

📝 Resumo: Startup de agentes de IA para atendimento; pede Node, AWS e LLM/RAG.
✅ Por que combina: Node + AWS + agentes LLM em produção
⚠️ Ponto de atenção: pede 6+ anos de Node.js
[🔗 Ver vaga]  [✉️ Gerar carta]
```

## Como funciona, em uma frase por etapa

1. **Busca:** 11 buscas (3 grupos de termos × remoto no Brasil, nos EUA e em Portugal, e São Paulo presencial/híbrido/remoto) com as vagas da última hora.
2. **Pré-filtro:** descarta BairesDev, júnior, estágio, staff, outras stacks (Java, .NET, PHP, mobile, front-end), QA, DevOps, suporte, gestão, vendas...
3. **Deduplicação:** empresa + título normalizado, lembrado por 30 dias. Repostagem não chega duas vezes.
4. **IA:** eliminatórios (residência fora do Brasil, presencial ou híbrido fora de SP, stack alheia) e nota ponderada (stack 40%, tipo de trabalho 25%, experiência 20%, outros 15%).
5. **Piso salarial** (só quando a vaga informa): R$ 10k CLT, R$ 13k PJ, moeda estrangeira convertida e comparada com R$ 13k.
6. **Telegram:** ≥ 70% chega na hora. 60–69% vai para o digest das 18h. O resto é descartado.
7. **Fallback:** se o LinkedIn bloquear, o robô troca para o Apify a cada 2h, avisa e volta sozinho.

## Documentação

Tudo está em **[docs/DOCUMENTACAO.md](docs/DOCUMENTACAO.md)**: ferramentas e o papel de cada uma, diagramas, configuração passo a passo, referência de configurações, limites e troubleshooting.

Para operar o robô (onde fica cada configuração, erros por serviço, troca de chaves, como pausar e como desligar), veja **[docs/INFRAESTRUTURA.md](docs/INFRAESTRUTURA.md)**.

## Comandos

```bash
npm test                          # testes offline (sem dependências)
DRY_RUN=1 LOG_JOBS=1 npm run scan # busca de verdade, sem enviar nada nem gravar no KV
npm run digest                    # envia o digest do dia
```

Para personalizar: `perfil.md` (o currículo que a IA lê) e `config/config.json` (termos, locais, filtros, pesos e pisos).
