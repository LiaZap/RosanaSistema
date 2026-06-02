import { and, eq, sql } from 'drizzle-orm';
import { db } from './../db/client.js';
import { deals, pipelineStages, conversations } from './../db/schema.js';
import { logger } from './logger.js';

/**
 * Cria deal automaticamente quando DANI detecta intenção de compra.
 *
 * Critérios pra criar deal:
 *  - Cliente disse algo como "quero comprar", "pode separar", "vou levar",
 *    "fechar pedido", "pode reservar", "pode mandar"
 *  - DANI escalou pra Bia (sinal de fechamento)
 *
 * Idempotente: se já existe deal pra essa conversation, não duplica.
 */

const BUY_INTENT_PATTERNS = [
  /\bquero (comprar|levar|fechar|pegar|esse|essa|o|a)\b/i,
  /\bpode (separar|reservar|mandar|enviar|fechar)\b/i,
  /\bvou (levar|comprar|fechar|querer|pegar|ficar com)\b/i,
  /\bfecha(r)? (o )?pedido\b/i,
  /\bme (manda|envia)( o)?\b.*\b(pix|pagamento|valor|link)\b/i,
  /\bcomo (fa[çc]o|pago|envio)\b.*\bpix\b/i,
  /\b(pix|pago) (já|aqui|pra você|para você)\b/i,
  /\b(qual|onde) (pago|pix|link)\b/i,
  /\b(separa|reserva)\b.*\b(pra mim|para mim)\b/i,
  /\b(esse|essa|isso)\b.*\b(serve|cabe|gostei)\b/i,
];

/** Detecta intenção FRACA de compra (perguntas comerciais) */
const SOFT_INTENT_PATTERNS = [
  /\b(quanto custa|qual o pre[çc]o|valor)\b/i,
  /\b(tem|tens) (o |a )?\w+/i, // "tem berço", "tens windi"
  /\b(disponivel|em estoque)\b/i,
  /\btamanho\b/i,
  /\b(foto|imagem|ver) (do|da)\b/i,
];

export function detectSoftBuyIntent(userMessage: string): boolean {
  return SOFT_INTENT_PATTERNS.some((p) => p.test(userMessage));
}

const ESCALATION_PHRASE = /vou transferir.*atendimento.*bia/i;

export function detectBuyIntent(userMessage: string, daniReply: string): boolean {
  const userHit = BUY_INTENT_PATTERNS.some((p) => p.test(userMessage));
  const escalation = ESCALATION_PHRASE.test(daniReply);
  return userHit || escalation;
}

/** Pega a primeira stage da pipeline (Novos Leads / Em Qualificação) */
async function findFirstStage(accountId: string): Promise<{ id: string } | null> {
  const rows = await db
    .select({ id: pipelineStages.id })
    .from(pipelineStages)
    .where(eq(pipelineStages.accountId, accountId))
    .orderBy(pipelineStages.position)
    .limit(1);
  return rows[0] ?? null;
}

/** Pega stage "Em Qualificação" se existir, ou primeira disponível */
async function findQualifyingStage(accountId: string): Promise<{ id: string } | null> {
  const rows = await db
    .select({ id: pipelineStages.id, name: pipelineStages.name })
    .from(pipelineStages)
    .where(eq(pipelineStages.accountId, accountId))
    .orderBy(pipelineStages.position);
  if (rows.length === 0) return null;
  const qualifying = rows.find((s) =>
    s.name.toLowerCase().includes('qualifica'),
  );
  return qualifying ?? rows[0];
}

/**
 * Cria deal se intenção de compra detectada e ainda não existe deal pra conversa.
 * Retorna o id do deal criado (ou existente).
 */
export async function createDealIfBuyIntent(opts: {
  accountId: string;
  conversationId: string;
  contactId: string;
  contactName: string | null;
  userMessage: string;
  daniReply: string;
}): Promise<{ created: boolean; dealId: string | null }> {
  const intentDetected = detectBuyIntent(opts.userMessage, opts.daniReply);
  if (!intentDetected) return { created: false, dealId: null };

  // Idempotência: já tem deal pra essa conversation?
  const existing = await db
    .select({ id: deals.id })
    .from(deals)
    .where(
      and(eq(deals.accountId, opts.accountId), eq(deals.conversationId, opts.conversationId)),
    )
    .limit(1);
  if (existing.length > 0) {
    return { created: false, dealId: existing[0].id };
  }

  // Escolhe stage (Em Qualificação se existir, senão primeira)
  const stage =
    (await findQualifyingStage(opts.accountId)) ?? (await findFirstStage(opts.accountId));
  if (!stage) return { created: false, dealId: null };

  // Cria deal
  const title = opts.contactName
    ? `Lead: ${opts.contactName}`
    : 'Lead novo (DANI)';

  const [deal] = await db
    .insert(deals)
    .values({
      accountId: opts.accountId,
      contactId: opts.contactId,
      stageId: stage.id,
      title,
      notes: `Auto-criado pela DANI a partir da conversa.\n\nÚltima msg cliente: "${opts.userMessage.slice(0, 200)}"`,
      createdByAi: true,
      conversationId: opts.conversationId,
    })
    .returning({ id: deals.id });

  logger.info(
    {
      accountId: opts.accountId,
      conversationId: opts.conversationId,
      dealId: deal.id,
      contactName: opts.contactName,
    },
    '[AutoDeal] criado automaticamente pela DANI',
  );

  // Emite evento SSE pro frontend mostrar notificação
  try {
    const { emitEvent } = await import('./events-stream.js');
    emitEvent({
      type: 'deal:created',
      accountId: opts.accountId,
      dealId: deal.id,
      title,
      byAi: true,
    });
  } catch (err) {
    logger.warn({ err: (err as Error).message }, '[AutoDeal] emit failed');
  }

  return { created: true, dealId: deal.id };
}

/** Move deal pra próxima stage (ex: Qualificação -> Oportunidade). */
export async function progressDealStage(opts: {
  accountId: string;
  conversationId: string;
}): Promise<void> {
  const [deal] = await db
    .select({ id: deals.id, stageId: deals.stageId })
    .from(deals)
    .where(
      and(eq(deals.accountId, opts.accountId), eq(deals.conversationId, opts.conversationId)),
    )
    .limit(1);
  if (!deal) return;

  const stages = await db
    .select({ id: pipelineStages.id, position: pipelineStages.position })
    .from(pipelineStages)
    .where(eq(pipelineStages.accountId, opts.accountId))
    .orderBy(pipelineStages.position);

  const currentIdx = stages.findIndex((s) => s.id === deal.stageId);
  if (currentIdx < 0 || currentIdx >= stages.length - 1) return;
  const next = stages[currentIdx + 1];

  await db
    .update(deals)
    .set({ stageId: next.id, updatedAt: new Date() })
    .where(eq(deals.id, deal.id));

  // ignore sql unused
  void sql;
  void conversations;
}
