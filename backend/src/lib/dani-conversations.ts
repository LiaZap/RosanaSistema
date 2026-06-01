import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { contacts, conversations, messages } from '../db/schema.js';
import type { ChatTurn } from './gemini-client.js';

/**
 * Helpers para gerenciar conversas e mensagens.
 *
 * Phase 2D: usado pelo orchestrator pra persistir interacoes do
 * /dani/chat. Phase 4 (WhatsApp) vai reutilizar isso com contatos
 * reais por phoneNumber.
 */

const TEST_PHONE_PREFIX = 'test:';

/**
 * Pega ou cria um contato "de teste" pra um user autenticado.
 * Phone fica como 'test:<userId-truncado>' pra nao colidir com numeros reais.
 * IMPORTANTE: schema atual limita phone_number a varchar(20), entao precisamos
 * truncar o userId (UUID tem 36 chars). Usamos os primeiros 14 chars do UUID
 * que ainda mantem unicidade dentro da account (que ja faz parte do where).
 * Total: 5 ('test:') + 14 = 19 chars, cabe em varchar(20).
 */
export async function getOrCreateTestContact(opts: {
  accountId: string;
  userId: string;
  userEmail: string;
}): Promise<{ id: string }> {
  const phone = `${TEST_PHONE_PREFIX}${opts.userId.replace(/-/g, '').slice(0, 14)}`;

  const existing = await db.query.contacts.findFirst({
    where: and(eq(contacts.accountId, opts.accountId), eq(contacts.phoneNumber, phone)),
    columns: { id: true },
  });
  if (existing) return existing;

  const [created] = await db
    .insert(contacts)
    .values({
      accountId: opts.accountId,
      phoneNumber: phone,
      name: `Teste (${opts.userEmail})`,
    })
    .returning({ id: contacts.id });

  return created;
}

/**
 * Cria uma nova conversa pra um contato.
 */
export async function createConversation(opts: {
  accountId: string;
  contactId: string;
}): Promise<{ id: string }> {
  const [created] = await db
    .insert(conversations)
    .values({
      accountId: opts.accountId,
      contactId: opts.contactId,
      status: 'nina',
    })
    .returning({ id: conversations.id });
  return created;
}

/**
 * Pega a conversa "ativa" mais recente de um contato. Se nao houver, cria.
 */
export async function getOrCreateActiveConversation(opts: {
  accountId: string;
  contactId: string;
}): Promise<{ id: string }> {
  const existing = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.accountId, opts.accountId),
        eq(conversations.contactId, opts.contactId),
        eq(conversations.status, 'nina'),
      ),
    )
    .orderBy(desc(conversations.lastMessageAt), desc(conversations.createdAt))
    .limit(1);

  if (existing[0]) return existing[0];
  return createConversation(opts);
}

/**
 * Carrega historico de mensagens em formato compativel com Gemini.
 * Retorna em ordem cronologica (mais antiga primeiro).
 */
export async function loadHistory(
  conversationId: string,
  limit = 30,
): Promise<ChatTurn[]> {
  const rows = await db
    .select({
      fromType: messages.fromType,
      content: messages.content,
    })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(limit);

  // Inverte pra cronologica (mais antiga -> mais nova)
  return rows
    .reverse()
    .filter((m) => m.content)
    .map((m) => ({
      role: m.fromType === 'user' ? ('user' as const) : ('model' as const),
      text: m.content as string,
    }));
}

/**
 * Salva uma mensagem na conversa e atualiza lastMessageAt.
 */
export async function saveMessage(opts: {
  conversationId: string;
  accountId: string;
  fromType: 'user' | 'nina' | 'human';
  content: string;
  processedByNina?: boolean;
}): Promise<{ id: string }> {
  const [saved] = await db
    .insert(messages)
    .values({
      conversationId: opts.conversationId,
      accountId: opts.accountId,
      fromType: opts.fromType,
      messageType: 'text',
      content: opts.content,
      processedByNina: opts.processedByNina ?? false,
    })
    .returning({ id: messages.id });

  // Quando humano envia mensagem: status=human + lastHumanAt
  // Quando user (cliente) envia: mantém status (DANI processa se 'nina')
  const now = new Date();
  const statusUpdate =
    opts.fromType === 'human'
      ? { status: 'human' as const, lastHumanAt: now }
      : {};

  await db
    .update(conversations)
    .set({ lastMessageAt: now, updatedAt: now, ...statusUpdate })
    .where(eq(conversations.id, opts.conversationId));

  return saved;
}

/**
 * Verifica se a DANI deve responder a essa conversa.
 * Retorna false se status='human' (operador assumiu) ou 'paused' ou 'closed'.
 */
export async function isDaniActiveForConversation(
  conversationId: string,
): Promise<boolean> {
  const conv = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
    columns: { status: true },
  });
  return conv?.status === 'nina';
}

/**
 * Reativa DANI numa conversa em modo human/paused.
 * Setta status='nina'.
 */
export async function reactivateDani(conversationId: string): Promise<void> {
  await db
    .update(conversations)
    .set({ status: 'nina', updatedAt: new Date() })
    .where(eq(conversations.id, conversationId));
}
