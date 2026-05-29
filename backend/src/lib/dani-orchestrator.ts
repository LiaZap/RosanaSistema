import { db } from '../db/client.js';
import { ninaSettings } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { buildDaniSystemPrompt } from './dani-prompt.js';
import {
  generateDaniReply,
  type ChatTurn,
  type ToolCallRecord,
} from './gemini-client.js';
import { DANI_TOOLS, TOOL_HANDLERS } from './dani-tools.js';
import { buscarProdutoDetalhe } from './dani-products.js';
import { logger } from './logger.js';

export interface DaniAttachment {
  type: 'image';
  url: string;
  caption?: string;
}

/**
 * Strip filler placeholders que o modelo costuma gerar.
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
  contactId?: string | null;
  history?: ChatTurn[];
}

export interface DaniResult {
  reply: string;
  modelUsed: string;
  durationMs: number;
  fillerStripped: boolean;
  toolCalls: ToolCallRecord[];
  iterations: number;
  attachments: DaniAttachment[];
}

/**
 * Core do processamento da DANI com tools.
 */
export async function processDaniMessage(
  message: string,
  ctx: DaniContext,
): Promise<DaniResult> {
  const start = Date.now();

  // Carrega settings da conta
  const settings = await db.query.ninaSettings.findFirst({
    where: eq(ninaSettings.accountId, ctx.accountId),
  });

  if (settings && !settings.isActive) {
    logger.info({ accountId: ctx.accountId }, '[DANI] settings.isActive=false - desativada');
    throw new Error('DANI is disabled for this account');
  }

  const systemPrompt = buildDaniSystemPrompt({
    systemPromptOverride: settings?.systemPromptOverride ?? null,
    sdrName: settings?.sdrName ?? null,
    companyName: settings?.companyName ?? null,
  });

  const modelMode = settings?.aiModelMode ?? 'flash';

  // Tool handler vinculado ao accountId + contactId (pra agendamento)
  const toolHandler = async (name: string, args: Record<string, unknown>) => {
    const handler = TOOL_HANDLERS[name];
    if (!handler) throw new Error(`Unknown tool: ${name}`);
    return handler(args, { accountId: ctx.accountId, contactId: ctx.contactId ?? null });
  };

  const generation = await generateDaniReply({
    systemPrompt,
    history: ctx.history ?? [],
    userMessage: message,
    modelMode,
    tools: DANI_TOOLS,
    toolHandler,
  });

  const { clean, stripped } = stripFillerPrefix(generation.text);

  if (stripped) {
    logger.info(
      { rawLength: generation.text.length, cleanLength: clean.length },
      '[DANI] filler stripped',
    );
  }

  // Fallback se sobrou nada util
  const finalReply = clean.length >= 5
    ? clean
    : 'Pode me contar mais sobre o que voce esta procurando?';

  // Extrai attachments das tool calls de detalhe (DANI quer mandar foto)
  const attachments: DaniAttachment[] = [];
  for (const tc of generation.toolCalls) {
    if (tc.name === 'buscar_produto_detalhe') {
      const consulta = String((tc.args as Record<string, unknown>).consulta ?? '');
      if (consulta) {
        try {
          const produto = await buscarProdutoDetalhe({ accountId: ctx.accountId, consulta });
          if (produto?.imagem) {
            attachments.push({
              type: 'image',
              url: produto.imagem,
            });
          }
        } catch {
          // ignore - sem foto, manda texto
        }
      }
    }
  }

  return {
    reply: finalReply,
    modelUsed: modelMode,
    durationMs: Date.now() - start,
    fillerStripped: stripped,
    toolCalls: generation.toolCalls,
    iterations: generation.iterations,
    attachments,
  };
}
