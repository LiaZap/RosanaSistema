import { eq } from 'drizzle-orm';
import { GoogleGenerativeAI, SchemaType, type ResponseSchema } from '@google/generative-ai';
import { db } from '../db/client.js';
import { conversations, messages } from '../db/schema.js';
import { logger } from './logger.js';

/**
 * Sprint 7 - Intent classifier + lead score.
 *
 * Roda async APOS o ai-reply terminar (nao bloqueia DANI).
 * Carrega historico recente, classifica via Gemini com responseSchema:
 *   intent_label: curioso | comprador | aluguel | consultoria | reclamacao | suporte | comprovante
 *   sentiment:    positivo | neutro | negativo
 *   lead_score:   0-100 (heuristica calorosa)
 *
 * Atualiza conversations.intent_label, lead_score e sentiment.
 *
 * Custo: 1 chamada Gemini-flash-lite por mensagem do user.
 * Vale a pena? Dashboard / triagem visual de leads quentes.
 */

const apiKey = process.env.GEMINI_API_KEY;
const client = new GoogleGenerativeAI(apiKey ?? '');

const VALID_INTENTS = [
  'curioso',
  'comprador',
  'aluguel',
  'consultoria',
  'reclamacao',
  'suporte',
  'comprovante',
  'despedida',
] as const;
type IntentLabel = (typeof VALID_INTENTS)[number];

const VALID_SENTIMENTS = ['positivo', 'neutro', 'negativo'] as const;
type Sentiment = (typeof VALID_SENTIMENTS)[number];

export interface IntentResult {
  intent: IntentLabel;
  sentiment: Sentiment;
  leadScore: number; // 0-100
  reasoning: string;
}

const SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    intent: { type: SchemaType.STRING },
    sentiment: { type: SchemaType.STRING },
    lead_score: { type: SchemaType.INTEGER },
    reasoning: { type: SchemaType.STRING },
  },
  required: ['intent', 'sentiment', 'lead_score', 'reasoning'],
};

const SYSTEM_PROMPT = `Voce e analista de leads. Classifique a ULTIMA mensagem do CLIENTE
(considerando o contexto) com:

intent (escolha 1):
- curioso: pergunta sem intencao clara de compra ("o que e?", "como funciona?")
- comprador: cliente esta avaliando compra ("quanto?", "tem em estoque?", "qual menor preco?")
- aluguel: cliente menciona alugar
- consultoria: cliente quer consultoria de enxoval
- reclamacao: cliente reclamou ou esta irritado
- suporte: duvida de uso, troca, devolucao
- comprovante: cliente mandou comprovante de pagamento
- despedida: cliente esta encerrando ("tchau", "obrigada")

sentiment: positivo | neutro | negativo

lead_score (0-100):
- 0-29: frio (curiosidade, sem urgencia)
- 30-69: morno (interesse real, mas indeciso)
- 70-100: quente (intencao clara, perto de comprar, pediu reservar, pediu foto especifica, perguntou frete)

reasoning: 1 frase curta explicando.`;

/**
 * Classifica intent + sentiment + lead_score de uma conversation.
 * Roda no fim do ai-reply, async, sem bloquear a resposta da DANI.
 */
export async function classifyConversation(conversationId: string): Promise<IntentResult | null> {
  if (!apiKey) {
    logger.warn('[Intent] GEMINI_API_KEY missing - skip classification');
    return null;
  }

  // Pega ultimas 10 mensagens (contexto + ultima do user)
  const msgs = await db
    .select({
      fromType: messages.fromType,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(messages.createdAt)
    .limit(10);

  if (msgs.length === 0) return null;

  // Encontra ultima msg do user (foco da classificacao)
  const lastUserMsg = [...msgs].reverse().find((m) => m.fromType === 'user');
  if (!lastUserMsg) return null;

  const transcript = msgs
    .filter((m) => m.content)
    .map((m) => {
      const role =
        m.fromType === 'user' ? 'CLIENTE' : m.fromType === 'nina' ? 'DANI' : 'HUMANO';
      return `${role}: ${m.content}`;
    })
    .join('\n');

  // Usa flash-lite (10x mais barato que flash). Volume alto.
  const model = client.getGenerativeModel({
    model: 'gemini-flash-lite-latest',
    systemInstruction: SYSTEM_PROMPT,
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseSchema: SCHEMA,
    },
  });

  const start = Date.now();
  try {
    const result = await model.generateContent(
      `<conversa>\n${transcript}\n</conversa>\n\nClassifique a ultima mensagem do CLIENTE.`,
    );
    const text = result.response.text();
    const parsed = JSON.parse(text) as {
      intent: string;
      sentiment: string;
      lead_score: number;
      reasoning: string;
    };

    // Validar enums e bounds
    const intent: IntentLabel = (VALID_INTENTS as readonly string[]).includes(parsed.intent)
      ? (parsed.intent as IntentLabel)
      : 'curioso';
    const sentiment: Sentiment = (VALID_SENTIMENTS as readonly string[]).includes(parsed.sentiment)
      ? (parsed.sentiment as Sentiment)
      : 'neutro';
    const leadScore = Math.max(0, Math.min(100, Math.floor(Number(parsed.lead_score) || 0)));

    const classified: IntentResult = {
      intent,
      sentiment,
      leadScore,
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
    };

    // Persiste em conversations
    await db
      .update(conversations)
      .set({
        intentLabel: classified.intent,
        sentiment: classified.sentiment,
        leadScore: classified.leadScore,
        updatedAt: new Date(),
      })
      .where(eq(conversations.id, conversationId));

    logger.info(
      {
        conversationId,
        intent: classified.intent,
        sentiment: classified.sentiment,
        leadScore: classified.leadScore,
        ms: Date.now() - start,
      },
      '[Intent] classified',
    );

    return classified;
  } catch (err) {
    logger.warn(
      { conversationId, err: (err as Error).message, ms: Date.now() - start },
      '[Intent] classification failed',
    );
    return null;
  }
}
