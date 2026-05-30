import { eq } from 'drizzle-orm';
import { GoogleGenerativeAI, SchemaType, type ResponseSchema } from '@google/generative-ai';
import { db } from '../db/client.js';
import { contacts, messages } from '../db/schema.js';
import { logger } from './logger.js';

/**
 * Sprint 8 - Memoria persistente do contato.
 *
 * Apos cada interacao, extrai automaticamente informacoes que ficam
 * salvas em contacts.client_memory (jsonb). Na proxima conversa, a
 * DANI carrega essa memoria como contexto.
 *
 * Campos persistidos:
 *  - nome_bebe?: string
 *  - mes_gestacao?: number
 *  - cidade?: string
 *  - produtos_de_interesse?: string[]
 *  - objecoes_levantadas?: string[]
 *  - compras_anteriores?: string[]
 *  - preferencias?: { cor?: string; marca_favorita?: string; estilo?: string }
 *  - notas_internas?: string[]
 *  - atualizado_em: ISO string
 */

const apiKey = process.env.GEMINI_API_KEY;
const client = new GoogleGenerativeAI(apiKey ?? '');

export interface ClientMemory {
  nome_bebe?: string;
  mes_gestacao?: number;
  cidade?: string;
  produtos_de_interesse?: string[];
  objecoes_levantadas?: string[];
  compras_anteriores?: string[];
  preferencias?: {
    cor?: string;
    marca_favorita?: string;
    estilo?: string;
  };
  notas_internas?: string[];
  atualizado_em?: string;
}

const SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    nome_bebe: { type: SchemaType.STRING },
    mes_gestacao: { type: SchemaType.INTEGER },
    cidade: { type: SchemaType.STRING },
    produtos_de_interesse: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
    objecoes_levantadas: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
    compras_anteriores: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
    preferencias: {
      type: SchemaType.OBJECT,
      properties: {
        cor: { type: SchemaType.STRING },
        marca_favorita: { type: SchemaType.STRING },
        estilo: { type: SchemaType.STRING },
      },
    },
    notas_internas: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
  },
};

const SYSTEM_PROMPT = `Voce e analista de conversas. Sua tarefa: extrair APENAS dados
factuais sobre o CLIENTE da conversa abaixo. Combine com a memoria existente.

REGRAS:
- Extraia SO o que esta EXPLICITAMENTE dito pelo cliente
- NUNCA invente / suponha / inferir agressivamente
- Se a info nao apareceu na conversa, NAO inclua o campo
- Combine com memoria existente (merge inteligente, nao apaga)
- Para produtos_de_interesse e objecoes, mantenha lista cumulativa
- Cores, tamanhos, marcas mencionadas pela cliente vao em preferencias
- notas_internas: max 3 frases curtas sobre traços importantes (ex:
  "mae de primeira viagem", "indecisa entre marcas", "valoriza preco baixo")

Output JSON com apenas os campos relevantes.`;

/**
 * Extrai/atualiza memoria do contato a partir das ultimas N mensagens.
 * Roda async no fim do ai-reply, sem bloquear.
 */
export async function updateContactMemory(opts: {
  conversationId: string;
  contactId: string;
}): Promise<ClientMemory | null> {
  if (!apiKey) {
    logger.warn('[ContactMemory] GEMINI_API_KEY missing - skip');
    return null;
  }

  // Pega memoria atual
  const contact = await db.query.contacts.findFirst({
    where: eq(contacts.id, opts.contactId),
  });
  if (!contact) return null;

  const existingMemory = (contact.clientMemory ?? {}) as ClientMemory;

  // Pega ultimas 30 mensagens pra dar contexto
  const msgs = await db
    .select({
      fromType: messages.fromType,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.conversationId, opts.conversationId))
    .orderBy(messages.createdAt)
    .limit(30);

  if (msgs.length === 0) return null;

  // Filtra so msgs com texto util
  const usefulMsgs = msgs.filter((m) => m.content);
  if (usefulMsgs.length === 0) return null;

  const transcript = usefulMsgs
    .map((m) => {
      const role =
        m.fromType === 'user' ? 'CLIENTE' : m.fromType === 'nina' ? 'DANI' : 'HUMANO';
      return `${role}: ${m.content}`;
    })
    .join('\n');

  const model = client.getGenerativeModel({
    model: 'gemini-2.5-flash-lite',
    systemInstruction: SYSTEM_PROMPT,
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json',
      responseSchema: SCHEMA,
    },
  });

  const userPrompt = `<memoria_atual>
${JSON.stringify(existingMemory, null, 2)}
</memoria_atual>

<conversa>
${transcript}
</conversa>

Extraia e MERGE com memoria atual. Retorne o JSON completo atualizado
(nao so o delta).`;

  try {
    const result = await model.generateContent(userPrompt);
    const text = result.response.text();
    const parsed = JSON.parse(text) as ClientMemory;

    // Sanitiza arrays (max 10 items cada, strings <=200 chars)
    if (parsed.produtos_de_interesse) {
      parsed.produtos_de_interesse = parsed.produtos_de_interesse
        .filter((s): s is string => typeof s === 'string')
        .slice(0, 10)
        .map((s) => s.slice(0, 200));
    }
    if (parsed.objecoes_levantadas) {
      parsed.objecoes_levantadas = parsed.objecoes_levantadas
        .filter((s): s is string => typeof s === 'string')
        .slice(0, 10)
        .map((s) => s.slice(0, 200));
    }
    if (parsed.notas_internas) {
      parsed.notas_internas = parsed.notas_internas
        .filter((s): s is string => typeof s === 'string')
        .slice(0, 5)
        .map((s) => s.slice(0, 300));
    }
    if (parsed.mes_gestacao) {
      parsed.mes_gestacao = Math.max(0, Math.min(10, Math.floor(parsed.mes_gestacao)));
    }

    const updated: ClientMemory = {
      ...existingMemory,
      ...parsed,
      atualizado_em: new Date().toISOString(),
    };

    await db
      .update(contacts)
      .set({
        clientMemory: updated as unknown as Record<string, unknown>,
        updatedAt: new Date(),
      })
      .where(eq(contacts.id, opts.contactId));

    logger.info(
      {
        contactId: opts.contactId,
        keys: Object.keys(updated),
      },
      '[ContactMemory] updated',
    );

    return updated;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, contactId: opts.contactId },
      '[ContactMemory] update failed',
    );
    return null;
  }
}

/** Formata memoria pra ser injetada no prompt da DANI */
export function formatMemoryForPrompt(memory: ClientMemory | null | undefined): string {
  if (!memory || Object.keys(memory).length === 0) return '';

  const parts: string[] = [];
  if (memory.nome_bebe) parts.push(`Nome do bebe: ${memory.nome_bebe}`);
  if (memory.mes_gestacao) parts.push(`Mes de gestacao: ${memory.mes_gestacao}`);
  if (memory.cidade) parts.push(`Cidade: ${memory.cidade}`);
  if (memory.preferencias) {
    const p = memory.preferencias;
    const parts2: string[] = [];
    if (p.cor) parts2.push(`cor preferida ${p.cor}`);
    if (p.marca_favorita) parts2.push(`marca favorita ${p.marca_favorita}`);
    if (p.estilo) parts2.push(`estilo ${p.estilo}`);
    if (parts2.length) parts.push(`Preferencias: ${parts2.join(', ')}`);
  }
  if (memory.produtos_de_interesse?.length) {
    parts.push(`Produtos de interesse: ${memory.produtos_de_interesse.slice(0, 5).join(', ')}`);
  }
  if (memory.objecoes_levantadas?.length) {
    parts.push(
      `Objecoes anteriores: ${memory.objecoes_levantadas.slice(0, 3).join('; ')}`,
    );
  }
  if (memory.compras_anteriores?.length) {
    parts.push(`Comprou antes: ${memory.compras_anteriores.slice(0, 5).join(', ')}`);
  }
  if (memory.notas_internas?.length) {
    parts.push(`Notas: ${memory.notas_internas.slice(0, 3).join('; ')}`);
  }

  return parts.length > 0
    ? `\n\n# MEMORIA DA CLIENTE (use pra personalizar mas nao mencione explicitamente que voce 'lembra')\n${parts.join('\n')}`
    : '';
}
