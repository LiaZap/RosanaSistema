import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { messages } from '../db/schema.js';
import { GoogleGenerativeAI, SchemaType, type ResponseSchema } from '@google/generative-ai';
import { logger } from './logger.js';

const apiKey = process.env.GEMINI_API_KEY;
const client = new GoogleGenerativeAI(apiKey ?? '');

export interface ConversationAnalysis {
  summary: string;
  intent: string;
  sentiment: 'positivo' | 'neutro' | 'negativo';
  qualification: 'frio' | 'morno' | 'quente';
  topics: string[];
  next_steps: string[];
  flags: {
    needs_human: boolean;
    needs_appointment: boolean;
    customer_unhappy: boolean;
  };
}

const ANALYSIS_PROMPT = `Voce e analista de conversas de vendas da Filhos com Estilo
(loja de enxoval, puericultura e consultorias em Nova Lima/MG).

Analise a conversa entre cliente e DANI/atendente humano abaixo e devolva
um JSON estruturado seguindo EXATAMENTE o schema definido.

Diretrizes:
- summary: 1-3 frases curtas, foco no que o cliente quer e o estado da conversa
- intent: 1 frase clara (ex: "comprar carrinho de bebe", "agendar consultoria smart baby")
- sentiment: como o cliente esta se sentindo
- qualification: temperatura do lead (frio=so curiosidade, morno=interesse real, quente=pronto pra fechar)
- topics: 1-5 topicos abordados (ex: "windi", "consultoria estilosa", "preco")
- next_steps: 1-3 acoes concretas que a vendedora humana deveria tomar
- flags.needs_human: cliente precisa de humano (objecao complexa, reclamacao, escalation)
- flags.needs_appointment: cliente quer/precisa agendar consultoria/visita
- flags.customer_unhappy: cliente reclamou ou demonstrou insatisfacao`;

const SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    summary: { type: SchemaType.STRING },
    intent: { type: SchemaType.STRING },
    sentiment: { type: SchemaType.STRING },
    qualification: { type: SchemaType.STRING },
    topics: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
    next_steps: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
    flags: {
      type: SchemaType.OBJECT,
      properties: {
        needs_human: { type: SchemaType.BOOLEAN },
        needs_appointment: { type: SchemaType.BOOLEAN },
        customer_unhappy: { type: SchemaType.BOOLEAN },
      },
      required: ['needs_human', 'needs_appointment', 'customer_unhappy'],
    },
  },
  required: ['summary', 'intent', 'sentiment', 'qualification', 'topics', 'next_steps', 'flags'],
};

/**
 * Roda analise de conversa via Gemini com JSON estruturado.
 */
export async function analyzeConversation(conversationId: string): Promise<ConversationAnalysis> {
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY not configured');
  }

  const rows = await db
    .select({
      fromType: messages.fromType,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(messages.createdAt)
    .limit(100);

  if (rows.length === 0) {
    throw new Error('No messages in this conversation');
  }

  const transcript = rows
    .filter((m) => m.content)
    .map((m) => {
      const role = m.fromType === 'user' ? 'CLIENTE' : m.fromType === 'nina' ? 'DANI' : 'HUMANO';
      return `${role}: ${m.content}`;
    })
    .join('\n');

  const model = client.getGenerativeModel({
    model: 'gemini-1.5-flash',
    systemInstruction: ANALYSIS_PROMPT,
    generationConfig: {
      temperature: 0.3,
      responseMimeType: 'application/json',
      responseSchema: SCHEMA,
    },
  });

  const start = Date.now();
  const result = await model.generateContent(`<conversa>\n${transcript}\n</conversa>`);
  const text = result.response.text();

  logger.info(
    { conversationId, ms: Date.now() - start, turns: rows.length },
    '[Analysis] complete',
  );

  return JSON.parse(text) as ConversationAnalysis;
}
