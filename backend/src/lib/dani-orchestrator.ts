import { db } from '../db/client.js';
import { contacts, ninaSettings } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { buildDaniSystemPrompt } from './dani-prompt.js';
import { formatMemoryForPrompt, type ClientMemory } from './contact-memory.js';
import {
  generateDaniReply,
  type ChatTurn,
  type ToolCallRecord,
} from './gemini-client.js';
import { DANI_TOOLS, TOOL_HANDLERS } from './dani-tools.js';
import { buscarProdutoDetalhe } from './dani-products.js';
import { loadContextualKB } from './knowledge-base.js';
import { logger } from './logger.js';

export interface DaniAttachment {
  type: 'image' | 'document' | 'video' | 'audio';
  url: string;
  caption?: string;
  fileName?: string;
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
  shouldReply: boolean;
  reasoning: string;
  modelUsed: string;
  durationMs: number;
  fillerStripped: boolean;
  toolCalls: ToolCallRecord[];
  iterations: number;
  attachments: DaniAttachment[];
}

/**
 * Parseia a resposta da DANI.
 *
 * Estrategia: TEXTO PURO eh o caminho feliz. JSON vira excecao defensiva
 * pra retro-compatibilidade com prompts customizados antigos que pedem JSON.
 *
 * - Resposta vazia (string=='' ou whitespace): silencio absoluto (esperado
 *   em comprovantes, despedidas curtas, conversa em modo human)
 * - Texto comum: resposta direta ao cliente
 * - JSON valido com should_reply: retro-compat, respeita o campo
 * - JSON malformado: STRIP do JSON (remove '{', '"should_reply"' etc) e
 *   extrai message. Anti-vazamento de JSON na bubble.
 */
function parseJsonResponse(raw: string): {
  shouldReply: boolean;
  message: string;
  reasoning: string;
  fellBack: boolean;
} {
  const trimmed = raw.trim();

  // Vazio = silencio absoluto intencional
  if (!trimmed) {
    return {
      shouldReply: false,
      message: '',
      reasoning: 'empty response (intentional silence)',
      fellBack: false,
    };
  }

  // Se nao parece JSON, retorna texto direto (caminho feliz - 95% dos casos)
  if (!trimmed.startsWith('{') && !trimmed.startsWith('```')) {
    return {
      shouldReply: true,
      message: trimmed,
      reasoning: 'plain text response',
      fellBack: false,
    };
  }

  // Tenta extrair JSON entre fences se vier em markdown
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const jsonCandidate = fenced ? fenced[1].trim() : trimmed;

  try {
    const obj = JSON.parse(jsonCandidate);
    if (typeof obj === 'object' && obj !== null) {
      const shouldReply = 'should_reply' in obj ? Boolean(obj.should_reply) : true;
      const msg = typeof obj.message === 'string' ? obj.message : '';
      return {
        shouldReply,
        message: msg,
        reasoning: typeof obj.reasoning === 'string' ? obj.reasoning : 'parsed JSON',
        fellBack: false,
      };
    }
  } catch {
    // JSON malformado / truncado - vai pro recovery abaixo
  }

  // Recovery: JSON malformado. Tenta extrair valor de "message" via regex
  // pra nao vazar { } e chaves pro cliente.
  const messageMatch = trimmed.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (messageMatch) {
    // Unescape basic JSON strings
    const recovered = messageMatch[1]
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
    return {
      shouldReply: true,
      message: recovered,
      reasoning: 'fallback: recovered message from malformed JSON',
      fellBack: true,
    };
  }

  // Ultima saida: pega texto entre primeiro " e ultimo "
  // ou retorna msg generica se nada extrair
  const fallbackText = trimmed.replace(/[{}"\[\]]/g, '').replace(/should_reply.*?,/g, '').trim();
  return {
    shouldReply: true,
    message: fallbackText.length > 5 ? fallbackText : 'Pode me contar mais sobre o que voce esta procurando?',
    reasoning: 'fallback: stripped JSON syntax',
    fellBack: true,
  };
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

  // Carrega chunks da KB contextualmente
  const kbChunks = await loadContextualKB({
    accountId: ctx.accountId,
    userMessage: message,
    maxChunks: 25,
  });

  // Sprint 8: carrega memoria do contato (se houver)
  let memoryText = '';
  if (ctx.contactId) {
    try {
      const contact = await db.query.contacts.findFirst({
        where: eq(contacts.id, ctx.contactId),
      });
      if (contact?.clientMemory) {
        memoryText = formatMemoryForPrompt(contact.clientMemory as ClientMemory);
      }
    } catch {
      // ignore
    }
  }

  let systemPrompt = buildDaniSystemPrompt({
    systemPromptOverride: settings?.systemPromptOverride ?? null,
    sdrName: settings?.sdrName ?? null,
    companyName: settings?.companyName ?? null,
    kbChunks,
  });

  // Anexa memoria se houver
  if (memoryText) {
    systemPrompt += memoryText;
  }

  logger.info(
    {
      accountId: ctx.accountId,
      systemPromptChars: systemPrompt.length,
      kbChunks: kbChunks.length,
    },
    '[DANI] system prompt built with KB',
  );

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

  // Parseia JSON output {should_reply, message, reasoning}
  const parsed = parseJsonResponse(generation.text);

  if (parsed.fellBack) {
    logger.warn(
      { rawSample: generation.text.slice(0, 200) },
      '[DANI] JSON parse fallback - prompt nao seguiu formato',
    );
  }

  // Alerta quando DANI usa muitas iteracoes (loop de tool calls)
  if (generation.iterations >= 4) {
    logger.warn(
      {
        iterations: generation.iterations,
        toolCalls: generation.toolCalls.map((tc) => ({
          name: tc.name,
          args: tc.args,
        })),
        userMsg: message.slice(0, 100),
      },
      '[DANI] high iterations - possible tool loop',
    );
  }

  // Strip filler do message extraido
  const { clean, stripped } = stripFillerPrefix(parsed.message);

  if (stripped) {
    logger.info(
      { rawLength: parsed.message.length, cleanLength: clean.length },
      '[DANI] filler stripped',
    );
  }

  // Detecta despedida/agradecimento pra forcar silencio absoluto
  // (mesmo que o modelo gere texto generico, nao envia)
  // Aceita "tchau, ate mais" / "obrigada, depois eu volto" etc.
  const userMsgNorm = message.toLowerCase().trim();
  // Match no INICIO ou MSG INTEIRA contendo palavra-chave de despedida
  const FAREWELL_KEYWORDS =
    /(^|\b)(tchau|obrigad[oa]|brigad[oa]|valeu|vlw|flw|fui|ate logo|ate mais|ate amanha|ate depois|obg|tmj|deixa pra la|deixa quieto)(\b|[!.,?]|$)/i;
  const isFarewell =
    FAREWELL_KEYWORDS.test(userMsgNorm) &&
    userMsgNorm.length < 80 && // msg curta sem pergunta no meio
    !/\?/.test(userMsgNorm); // sem pergunta = nao quer info, so despedida

  // Final reply respeitando should_reply do JSON
  let finalReply = '';
  if (isFarewell) {
    // Despedida = silencio absoluto (regra de ouro DANI)
    finalReply = '';
    logger.info({ userMsg: message.slice(0, 50) }, '[DANI] farewell detected - silenced');
  } else if (parsed.shouldReply) {
    // Texto vazio com flag shouldReply=true geralmente = filler todo strippado.
    // NAO enviar texto generico inventado: melhor ficar em silencio mesmo.
    finalReply = clean.length >= 5 ? clean : '';
  }

  // Extrai attachments das tool calls (DANI quer mandar foto OU arquivo)
  const attachments: DaniAttachment[] = [];
  for (const tc of generation.toolCalls) {
    if (tc.name === 'buscar_produto_detalhe') {
      const consulta = String((tc.args as Record<string, unknown>).consulta ?? '');
      if (consulta) {
        try {
          const produto = await buscarProdutoDetalhe({ accountId: ctx.accountId, consulta });
          // Manda TODAS as imagens FULL conforme cadastradas no Bling (max 5).
          // imagens[] vem do mapRow - cada item eh /media/file/:id/:idx
          const imgs = produto?.imagens && produto.imagens.length > 0
            ? produto.imagens
            : (produto?.imagem ? [produto.imagem] : []);
          for (const url of imgs) {
            attachments.push({ type: 'image', url });
          }
          logger.info(
            { consulta, count: imgs.length, bling: produto?.blingId },
            '[DANI] image attachments from product',
          );
        } catch (err) {
          logger.warn({ err: (err as Error).message }, '[DANI] product detail failed');
        }
      }
    }
    // Sprint 4: enviar_arquivo result -> attachment
    if (tc.name === 'enviar_arquivo') {
      try {
        const preview = JSON.parse(tc.resultPreview) as {
          status?: string;
          arquivos?: Array<{ nome?: string; tipo?: string; url?: string }>;
        };
        if (preview.status === 'ENVIADO' && preview.arquivos) {
          for (const arq of preview.arquivos.slice(0, 3)) {
            if (!arq.url) continue;
            const tipo = (arq.tipo ?? '').toLowerCase();
            const isImage = tipo.includes('image') || tipo.includes('jpg') || tipo.includes('png');
            const isVideo = tipo.includes('video') || tipo.includes('mp4');
            const isAudio = tipo.includes('audio') || tipo.includes('mp3') || tipo.includes('ogg');
            attachments.push({
              type: isImage ? 'image' : isVideo ? 'video' : isAudio ? 'audio' : 'document',
              url: arq.url,
              fileName: arq.nome,
            });
          }
        }
      } catch {
        // ignore
      }
    }
  }

  // SALVA-VIDAS: se Gemini esgotou iterations e ficou em silencio MAS achou
  // produto via buscar_produto_detalhe, monta resposta minima a partir do
  // ultimo produto encontrado em vez de mandar nada.
  if (!finalReply && !isFarewell && attachments.length > 0) {
    // Pega o ultimo produto da ultima tool call buscar_produto_detalhe
    const lastProductCall = [...generation.toolCalls]
      .reverse()
      .find((tc) => tc.name === 'buscar_produto_detalhe');
    if (lastProductCall) {
      const consulta = String((lastProductCall.args as Record<string, unknown>).consulta ?? '');
      try {
        const produto = await buscarProdutoDetalhe({ accountId: ctx.accountId, consulta });
        if (produto) {
          const preco = produto.preco ? `R$ ${produto.preco.toFixed(2).replace('.', ',')}` : '';
          finalReply =
            `Aqui está o *${produto.nome}*!` +
            (preco ? ` Está por *${preco}*.` : '') +
            `\n\nQuer que eu separe pra você?`;
          logger.info(
            { consulta, produto: produto.nome },
            '[DANI] fallback reply from product (gemini silenced)',
          );
        }
      } catch (err) {
        logger.warn({ err: (err as Error).message }, '[DANI] fallback reply failed');
      }
    }
  }

  return {
    reply: finalReply,
    shouldReply: !!finalReply,
    reasoning: parsed.reasoning,
    modelUsed: modelMode,
    durationMs: Date.now() - start,
    fillerStripped: stripped,
    toolCalls: generation.toolCalls,
    iterations: generation.iterations,
    attachments,
  };
}
