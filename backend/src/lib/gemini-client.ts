import { GoogleGenerativeAI, type GenerativeModel } from '@google/generative-ai';
import { logger } from './logger.js';

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  logger.warn('[Gemini] GEMINI_API_KEY not set - DANI will fail at runtime');
}

const client = new GoogleGenerativeAI(apiKey ?? '');

/**
 * Resolve um modo logico (flash/pro/preview) pro nome do modelo Gemini.
 * Mantemos isso configuravel via nina_settings.aiModelMode.
 */
export function resolveModelName(mode: string | null | undefined): string {
  switch ((mode ?? 'flash').toLowerCase()) {
    case 'pro':
      return 'gemini-1.5-pro';
    case 'preview':
    case '2.0':
      return 'gemini-2.0-flash-exp';
    case 'flash':
    default:
      return 'gemini-1.5-flash';
  }
}

export function getModel(modeOrName?: string | null): GenerativeModel {
  const name = modeOrName && modeOrName.startsWith('gemini-')
    ? modeOrName
    : resolveModelName(modeOrName);
  return client.getGenerativeModel({ model: name });
}

export type ChatTurn = { role: 'user' | 'model'; text: string };

/**
 * Wrapper minimo de chat. Recebe systemPrompt + historico + nova mensagem,
 * devolve texto da resposta.
 *
 * Phase 2A: sem tools. Phase 2B vai adicionar functionDeclarations + toolCall handling.
 */
export async function generateDaniReply(opts: {
  systemPrompt: string;
  history: ChatTurn[];
  userMessage: string;
  modelMode?: string | null;
}): Promise<string> {
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured on the backend');
  }

  const model = client.getGenerativeModel({
    model: resolveModelName(opts.modelMode),
    systemInstruction: opts.systemPrompt,
    generationConfig: {
      temperature: 0.7,
      topP: 0.95,
      maxOutputTokens: 800,
    },
  });

  const chat = model.startChat({
    history: opts.history.map((t) => ({
      role: t.role,
      parts: [{ text: t.text }],
    })),
  });

  const start = Date.now();
  const result = await chat.sendMessage(opts.userMessage);
  const text = result.response.text();
  const ms = Date.now() - start;

  logger.info(
    { ms, inputChars: opts.userMessage.length, outputChars: text.length },
    '[Gemini] DANI reply generated',
  );

  return text;
}
