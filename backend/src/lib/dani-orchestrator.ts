import { db } from '../db/client.js';
import { ninaSettings } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { buildDaniSystemPrompt } from './dani-prompt.js';
import { generateDaniReply, type ChatTurn } from './gemini-client.js';
import { logger } from './logger.js';

/**
 * Sanitiza a resposta da DANI removendo filler placeholders que o modelo
 * costuma gerar mesmo sob instrucao explicita.
 *
 * Fase 2A: regras basicas. Fase 2B vai adicionar paranoid mode + trigger SQL.
 */
const FILLER_PATTERNS: RegExp[] = [
  /^entendi[!.,\s]*(como posso ajudar)?[!?.]*\s*/i,
  /^perfeito[!.,\s]*(como posso ajudar)?[!?.]*\s*/i,
  /^(um|so um)\s+momento[!.,\s]*/i,
  /^(vou|deixa eu)\s+(verificar|buscar|pesquisar|procurar|olhar|checar)[\s\S]*?[.!]\s*/i,
  /^aguarde[!.,\s]*/i,
  /^(ok|claro)[!.,\s]*(vou|deixa)/i,
];

export function stripFillerPrefix(text: string): { clean: string; stripped: boolean } {
  let clean = text.trim();
  let stripped = false;
  for (const pattern of FILLER_PATTERNS) {
    const before = clean;
    clean = clean.replace(pattern, '').trim();
    if (clean !== before) {
      stripped = true;
    }
  }
  return { clean, stripped };
}

export interface DaniContext {
  accountId: string;
  history?: ChatTurn[];
}

export interface DaniResult {
  reply: string;
  modelUsed: string;
  durationMs: number;
  fillerStripped: boolean;
}

/**
 * Core do processamento da DANI.
 *
 * Phase 2A: stateless - recebe historico inline, devolve resposta.
 * Phase 2B: vai puxar historico do banco e suportar tool calls.
 * Phase 2C: vai enfileirar via BullMQ pro worker processar.
 */
export async function processDaniMessage(
  message: string,
  ctx: DaniContext,
): Promise<DaniResult> {
  const start = Date.now();

  // Carrega settings da conta (override de prompt, modelo, sdrName)
  const settings = await db.query.ninaSettings.findFirst({
    where: eq(ninaSettings.accountId, ctx.accountId),
  });

  if (settings && !settings.isActive) {
    logger.info({ accountId: ctx.accountId }, '[DANI] settings.isActive=false - DANI desativada');
    throw new Error('DANI is disabled for this account');
  }

  const systemPrompt = buildDaniSystemPrompt({
    systemPromptOverride: settings?.systemPromptOverride ?? null,
    sdrName: settings?.sdrName ?? null,
    companyName: settings?.companyName ?? null,
  });

  const modelMode = settings?.aiModelMode ?? 'flash';

  // Chama Gemini
  const rawReply = await generateDaniReply({
    systemPrompt,
    history: ctx.history ?? [],
    userMessage: message,
    modelMode,
  });

  // Strip filler
  const { clean, stripped } = stripFillerPrefix(rawReply);

  if (stripped) {
    logger.info(
      { rawLength: rawReply.length, cleanLength: clean.length },
      '[DANI] filler stripped from reply',
    );
  }

  // Se sobrou nada util, retorna fallback minimo (anti tela em branco)
  const finalReply = clean.length >= 5
    ? clean
    : 'Pode me contar mais sobre o que voce esta procurando?';

  return {
    reply: finalReply,
    modelUsed: modelMode,
    durationMs: Date.now() - start,
    fillerStripped: stripped,
  };
}
