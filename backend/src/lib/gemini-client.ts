import {
  GoogleGenerativeAI,
  type FunctionDeclaration,
  type GenerativeModel,
  type Content,
} from '@google/generative-ai';
import { logger } from './logger.js';

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  logger.warn('[Gemini] GEMINI_API_KEY not set - DANI will fail at runtime');
}

const client = new GoogleGenerativeAI(apiKey ?? '');

/**
 * Resolve um modo logico (flash/pro/preview) pro nome do modelo Gemini.
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

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  resultPreview: string; // primeiros 200 chars do JSON pra log
}

export interface GenerateResult {
  text: string;
  toolCalls: ToolCallRecord[];
  iterations: number;
}

const MAX_TOOL_ITERATIONS = 5;

/**
 * Gera resposta da DANI com suporte a function calling.
 *
 * Loop:
 *  1. Envia mensagem do user
 *  2. Se Gemini sugere chamada(s) de tool, executa todas em paralelo
 *  3. Manda resultado(s) como functionResponse
 *  4. Repete ate Gemini retornar texto sem chamada (max 5 iteracoes)
 *
 * Se tools=null, comporta-se como Phase 2A (chat normal).
 */
export async function generateDaniReply(opts: {
  systemPrompt: string;
  history: ChatTurn[];
  userMessage: string;
  modelMode?: string | null;
  tools?: FunctionDeclaration[];
  toolHandler?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}): Promise<GenerateResult> {
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
    ...(opts.tools && opts.tools.length > 0
      ? { tools: [{ functionDeclarations: opts.tools }] }
      : {}),
  });

  const history: Content[] = opts.history.map((t) => ({
    role: t.role,
    parts: [{ text: t.text }],
  }));

  const chat = model.startChat({ history });

  const toolCalls: ToolCallRecord[] = [];
  let iterations = 0;

  // Primeira mensagem do user
  let result = await chat.sendMessage(opts.userMessage);

  while (iterations < MAX_TOOL_ITERATIONS) {
    const calls = result.response.functionCalls();

    // Sem function calls -> resposta final
    if (!calls || calls.length === 0) {
      const text = result.response.text();
      logger.info(
        {
          iterations: iterations + 1,
          toolCallsTotal: toolCalls.length,
          outputChars: text.length,
        },
        '[Gemini] DANI reply ready',
      );
      return { text, toolCalls, iterations: iterations + 1 };
    }

    if (!opts.toolHandler) {
      logger.warn(
        { calls: calls.map((c) => c.name) },
        '[Gemini] tools requested but no handler provided',
      );
      // Retorna o texto (mesmo que vazio) pra evitar loop infinito
      return { text: result.response.text() ?? '', toolCalls, iterations: iterations + 1 };
    }

    // Executa todas as tools em paralelo
    const toolResponses = await Promise.all(
      calls.map(async (call) => {
        const args = (call.args ?? {}) as Record<string, unknown>;
        const startTool = Date.now();
        try {
          const toolResult = await opts.toolHandler!(call.name, args);
          const preview = JSON.stringify(toolResult).slice(0, 200);
          toolCalls.push({ name: call.name, args, resultPreview: preview });
          logger.info(
            { tool: call.name, args, ms: Date.now() - startTool },
            '[Gemini] tool executed',
          );
          return {
            functionResponse: {
              name: call.name,
              response: toolResult as object,
            },
          };
        } catch (err) {
          const errorMsg = (err as Error).message;
          logger.error({ tool: call.name, err: errorMsg }, '[Gemini] tool failed');
          toolCalls.push({
            name: call.name,
            args,
            resultPreview: `ERROR: ${errorMsg.slice(0, 150)}`,
          });
          return {
            functionResponse: {
              name: call.name,
              response: { status: 'ERROR', error: errorMsg },
            },
          };
        }
      }),
    );

    // Envia resultados pro Gemini
    result = await chat.sendMessage(toolResponses);
    iterations++;
  }

  logger.warn({ iterations, toolCalls: toolCalls.length }, '[Gemini] hit max tool iterations');
  return {
    text: result.response.text() ?? '',
    toolCalls,
    iterations,
  };
}
