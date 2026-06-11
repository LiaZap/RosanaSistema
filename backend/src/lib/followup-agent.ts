import { and, asc, desc, eq, isNotNull, lt, or, sql } from 'drizzle-orm';
import { GoogleGenerativeAI, SchemaType, type ResponseSchema } from '@google/generative-ai';
import { db } from '../db/client.js';
import { conversations, contacts, messages, ninaSettings } from '../db/schema.js';
import { resolveModelName } from './gemini-client.js';
import { logger } from './logger.js';

/**
 * Sprint 5+6 - Follow-up agent.
 *
 * Roda a cada 5min via cron. Para cada conversa que ficou idle, decide
 * via Gemini com responseSchema o que fazer.
 *
 * Estados controlados aqui:
 *  followup_state: 'idle' (default) -> 'scheduled' -> 'sent' | 'declined' | 'closed'
 *
 * Politica de tentativas: max 2 attempts. Apos isso, fecha conversa.
 * Proativo roda 8h-17h (Rosana so esta na loja ate 17h), mas NAO perde
 * follow-up devido fora do horario — adia e dispara no primeiro horario (8h).
 * Responder mensagem que CHEGA continua 24h (a DANI sempre ativa). Anti-spam:
 * caps de tentativa.
 *
 * Janelas:
 *  - status='human' + ultima msg foi do USER + > 4h -> Bia respondeu, cliente sumiu = candidato
 *  - status='human' + ultima msg foi do HUMAN + > 4h -> Bia mandou, cliente nao respondeu = candidato
 *  - status='human' + ultima msg foi do USER + < 4h -> Bia ainda esta no comando = SKIP
 *  - status='nina' + ultima msg foi do USER + > 24h -> candidato pra recovery
 *
 * Anti-spam:
 *  - Max 2 attempts (cap por ciclo) + cap total
 *  - Atomic claim (state idle/scheduled/sent + UPDATE returning) impede multi-instancia
 */

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
// Janela ativa do follow-up PROATIVO (America/Sao_Paulo): 8h-17h. Combinado com
// a Rosana — apos 17h ela nao esta na loja pra resolver o que depender dela.
// Fora da janela a DANI nao reaborda, mas o follow-up NAO se perde: dispara no
// primeiro horario (8h, ver runFollowupTick). Responder msg que chega = 24h.
const ACTIVE_HOUR_START = 8;
const ACTIVE_HOUR_END = 17;
const MAX_ATTEMPTS = 2;
const MAX_TOTAL_ATTEMPTS = 6; // Cap absoluto: cliente nunca recebe mais que isso
const SUBSTANTIVE_REPLY_MIN_CHARS = 20; // Reset attempts so se cliente respondeu substantivo

const apiKey = process.env.GEMINI_API_KEY;
const client = new GoogleGenerativeAI(apiKey ?? '');

export interface FollowupDecision {
  action: 'send_recovery' | 'stay_silent' | 'close_conversation' | 'wait_more';
  message: string;
  reasoning: string;
}

const DECISION_SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    action: { type: SchemaType.STRING },
    message: { type: SchemaType.STRING },
    reasoning: { type: SchemaType.STRING },
  },
  required: ['action', 'message', 'reasoning'],
};

const SYSTEM_PROMPT = `Voce e analista de conversas de venda. Analise a conversa abaixo
entre DANI (assistente vendedora) / HUMANO (atendente humana Bia) e o CLIENTE.

A conversa esta inativa ha um tempo. Voce decide o que fazer agora:

- send_recovery: gerar uma mensagem curta de recuperacao da venda
- stay_silent: nao mandar nada (cliente fechou, despediu, reclamou, ou venda ja foi feita)
- close_conversation: marcar como encerrada (foi resolvida ha tempo)
- wait_more: ainda nao eh hora (ex: tempo insuficiente, fim de semana)

REGRA DE OURO: so reaborde quem tem decisao EM ABERTO. Se o cliente deu QUALQUER
sinal de que ja resolveu, desistiu de vez, ou o motivo da compra expirou ->
stay_silent ou close_conversation, JAMAIS send_recovery. Reabordar quem ja
resolveu incomoda e queima a marca.

CRITERIOS pra send_recovery:
- Cliente disse "vou pensar", "depois te falo", "vou ver com X" -> SIM
- Cliente perguntou preco e sumiu (decisao em aberto) -> SIM
- Cliente demonstrou interesse mas nao confirmou compra -> SIM
- Conversa tem deal em aberto -> SIM

CRITERIOS pra stay_silent:
- Cliente se despediu ("tchau", "obrigada") -> SIM
- Cliente mandou comprovante (venda fechada) -> SIM
- Cliente reclamou ou ficou bravo -> SIM
- Cliente JA RESPONDEU/DECLINOU: "nao", "nao vou precisar", "nao preciso mais",
  "nao quero", "nao vou levar", "ja resolvi", "comprei em outro lugar", era pra
  uma DATA que ja passou (cha, evento, aniversario), ou desistiu -> SIM.
  REGRA DA ROSANA: basta o cliente dizer "nao" UMA vez -> NUNCA reaborde. 1
  abordagem so. So reaborda quem ficou em SILENCIO (e ai no maximo 2x).
- Atendimento foi escalado pra Bia e ela respondeu (so silencio ate ela voltar) -> SIM

CRITERIOS pra close_conversation:
- Conversa idle ha > 5 dias E ja teve recovery sem retorno -> SIM
- Cliente recusou explicitamente o produto > 1x -> SIM

REGRAS de message (quando action=send_recovery):
- Curta (max 2 frases). Tom: caloroso, natural.
- Cita o produto/topico se foi mencionado
- Pergunta direta que convida resposta (nao 'tudo bem?')
- Negrito *com 1 asterisco*. Sem hifen.
- NUNCA "Oi de novo!", "Voltando ao assunto", "Tudo certo?", "Como posso ajudar?"

Bons exemplos:
- "Oi! Conseguiu decidir sobre o *Carrinho Ping Two*? Ainda tenho ele em estoque."
- "Pensou com a sua mae sobre o *enxoval*? Tô aqui se quiser que eu separe."
- "Boa tarde! Voce ainda esta procurando *manta*? Chegaram alguns modelos novos."

Para action != send_recovery: message = "".`;

interface ConversationContext {
  conversationId: string;
  accountId: string;
  contactName: string | null;
  contactPhone: string;
  status: string;
  lastMessages: Array<{ fromType: string; content: string | null; createdAt: Date }>;
  attempts: number;
  hoursSinceLastMessage: number;
  modelMode: string;
}

/**
 * Roda follow-up tick - encontra conversas candidatas e decide ação pra cada.
 *
 * Se accountId for passado, filtra so candidatos dessa conta (uso: endpoint manual).
 * Sem accountId: varre todas as contas (uso: cron).
 */
export async function runFollowupTick(opts: { accountId?: string } = {}): Promise<{
  scanned: number;
  decisions: Record<string, number>;
  errors: number;
}> {
  // Janela do follow-up PROATIVO: 8h-17h (Rosana so esta na loja ate 17h).
  // Fora dela NAO reaborda, mas NAO perde: o candidato continua elegivel e o
  // cron (a cada 5min) dispara no PRIMEIRO horario (8h). Responder a mensagem
  // que CHEGA continua 24h — isto aqui e so o proativo (reabordar quem sumiu).
  if (!isActiveHourSP()) {
    logger.debug('[Followup] fora da janela 8h-17h, adia follow-up pro primeiro horario');
    return { scanned: 0, decisions: {}, errors: 0 };
  }

  const now = new Date();
  const fourHoursAgo = new Date(now.getTime() - FOUR_HOURS_MS);
  const twentyFourHoursAgo = new Date(now.getTime() - TWENTY_FOUR_HOURS_MS);

  // Candidatos: idle/scheduled, max attempts/cycle E max total nao atingidos,
  // janela correta por status. Filtro SQL com OR por status pra nao acumular fim de semana.
  const baseConds = [
    sql`${conversations.followupAttempts} < ${MAX_ATTEMPTS}`,
    sql`${conversations.followupTotalAttempts} < ${MAX_TOTAL_ATTEMPTS}`,
    or(
      eq(conversations.followupState, 'idle'),
      eq(conversations.followupState, 'scheduled'),
    ),
    isNotNull(conversations.lastMessageAt),
    or(
      and(eq(conversations.status, 'human'), lt(conversations.lastMessageAt, fourHoursAgo)),
      and(eq(conversations.status, 'nina'), lt(conversations.lastMessageAt, twentyFourHoursAgo)),
    ),
  ];
  if (opts.accountId) {
    baseConds.push(eq(conversations.accountId, opts.accountId));
  }

  const candidates = await db
    .select({
      id: conversations.id,
      accountId: conversations.accountId,
      contactId: conversations.contactId,
      status: conversations.status,
      lastMessageAt: conversations.lastMessageAt,
      followupState: conversations.followupState,
      followupAttempts: conversations.followupAttempts,
      contactName: contacts.name,
      contactPhone: contacts.phoneNumber,
    })
    .from(conversations)
    .innerJoin(contacts, eq(conversations.contactId, contacts.id))
    .where(and(...baseConds))
    .orderBy(asc(conversations.lastMessageAt))
    .limit(50);

  if (candidates.length === 0) {
    return { scanned: 0, decisions: {}, errors: 0 };
  }

  const decisions: Record<string, number> = {};
  let errors = 0;
  let processed = 0;

  for (const cand of candidates) {
    try {
      // CLAIM ATOMICO: tenta marcar pra 'scheduled' antes de chamar LLM.
      // Se outro worker ja pegou, returning vem vazio e a gente skip.
      const claimed = await db
        .update(conversations)
        .set({ followupState: 'scheduled', updatedAt: new Date() })
        .where(
          and(
            eq(conversations.id, cand.id),
            eq(conversations.followupState, cand.followupState),
          ),
        )
        .returning({ id: conversations.id });

      if (claimed.length === 0) {
        logger.debug({ conversationId: cand.id }, '[Followup] race - already claimed');
        continue;
      }

      // Pega ultimas 20 mensagens (com fromType pra checar quem mandou ultima)
      const msgs = await db
        .select({
          fromType: messages.fromType,
          content: messages.content,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .where(eq(messages.conversationId, cand.id))
        .orderBy(desc(messages.createdAt))
        .limit(20);

      if (msgs.length === 0) {
        // Libera claim
        await db
          .update(conversations)
          .set({ followupState: 'idle' })
          .where(eq(conversations.id, cand.id));
        continue;
      }

      // G1: Se ultima msg foi de humano (Bia) ha menos de 24h E status=human,
      // a Bia esta no comando. Nao interromper.
      const lastMsg = msgs[0];
      if (cand.status === 'human' && lastMsg.fromType === 'human') {
        const hoursSinceHuman = (now.getTime() - lastMsg.createdAt.getTime()) / 3_600_000;
        if (hoursSinceHuman < 24) {
          logger.debug(
            { conversationId: cand.id, hoursSinceHuman },
            '[Followup] Bia recent message, skip',
          );
          // Volta o state pra idle (estava como scheduled da claim)
          await db
            .update(conversations)
            .set({ followupState: 'idle' })
            .where(eq(conversations.id, cand.id));
          continue;
        }
      }

      // Carrega settings da conta pra escolher model
      const settings = await db.query.ninaSettings.findFirst({
        where: eq(ninaSettings.accountId, cand.accountId),
      });

      const hoursSinceLast =
        (now.getTime() - (cand.lastMessageAt?.getTime() ?? 0)) / 3_600_000;

      const ctx: ConversationContext = {
        conversationId: cand.id,
        accountId: cand.accountId,
        contactName: cand.contactName,
        contactPhone: cand.contactPhone,
        status: cand.status,
        lastMessages: [...msgs].reverse(), // nao muta o array original
        attempts: cand.followupAttempts,
        hoursSinceLastMessage: hoursSinceLast,
        modelMode: settings?.aiModelMode ?? 'flash',
      };

      const decision = await decideAction(ctx);
      decisions[decision.action] = (decisions[decision.action] ?? 0) + 1;

      await applyDecision(ctx, decision);
      processed++;
    } catch (err) {
      errors++;
      // Libera o claim em caso de erro pra nao deixar travado
      await db
        .update(conversations)
        .set({ followupState: 'idle' })
        .where(
          and(eq(conversations.id, cand.id), eq(conversations.followupState, 'scheduled')),
        )
        .catch(() => {});
      logger.error(
        { conversationId: cand.id, err: (err as Error).message },
        '[Followup] decision failed',
      );
    }
  }

  logger.info(
    { scanned: candidates.length, processed, decisions, errors, accountId: opts.accountId },
    '[Followup] tick complete',
  );
  return { scanned: candidates.length, decisions, errors };
}

/**
 * Hora atual em America/Sao_Paulo (Intl, lida com DST). Define a janela ativa
 * do follow-up PROATIVO (8h-17h). Fora dela retorna false -> o tick adia, mas
 * o candidato continua elegivel e dispara quando a janela reabre (8h).
 */
function isActiveHourSP(): boolean {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Sao_Paulo',
      hour12: false,
      hour: '2-digit',
    });
    const hour = Number(fmt.format(new Date()));
    if (isNaN(hour)) return true; // em duvida, deixa rodar (follow-up "tem que acontecer")
    return hour >= ACTIVE_HOUR_START && hour < ACTIVE_HOUR_END;
  } catch {
    // Fallback UTC-3 hardcoded
    const hourBR = (new Date().getUTCHours() - 3 + 24) % 24;
    return hourBR >= ACTIVE_HOUR_START && hourBR < ACTIVE_HOUR_END;
  }
}

async function decideAction(ctx: ConversationContext): Promise<FollowupDecision> {
  if (!apiKey) {
    logger.error('[Followup] GEMINI_API_KEY not configured - cannot decide');
    return {
      action: 'stay_silent',
      message: '',
      reasoning: 'GEMINI_API_KEY missing',
    };
  }

  const transcript = ctx.lastMessages
    .filter((m) => m.content)
    .map((m) => {
      const role =
        m.fromType === 'user' ? 'CLIENTE' : m.fromType === 'nina' ? 'DANI' : 'HUMANO';
      return `${role}: ${m.content}`;
    })
    .join('\n');

  const model = client.getGenerativeModel({
    model: resolveModelName(ctx.modelMode),
    systemInstruction: SYSTEM_PROMPT,
    generationConfig: {
      temperature: 0.3,
      responseMimeType: 'application/json',
      responseSchema: DECISION_SCHEMA,
    },
  });

  const userPrompt = `<conversa>
${transcript}
</conversa>

Contexto:
- Status atual: ${ctx.status}
- Horas desde ultima msg: ${Math.round(ctx.hoursSinceLastMessage)}
- Tentativas anteriores de follow-up: ${ctx.attempts}
- Nome do contato: ${ctx.contactName ?? 'desconhecido'}

Decida.`;

  const result = await model.generateContent(userPrompt);
  const text = result.response.text();
  try {
    return JSON.parse(text) as FollowupDecision;
  } catch (err) {
    logger.error(
      {
        err: (err as Error).message,
        textSample: text.slice(0, 300),
        conversationId: ctx.conversationId,
      },
      '[Followup] Gemini returned invalid JSON',
    );
    return {
      action: 'wait_more',
      message: '',
      reasoning: `JSON parse error: ${(err as Error).message.slice(0, 100)}`,
    };
  }
}

async function applyDecision(
  ctx: ConversationContext,
  decision: FollowupDecision,
): Promise<void> {
  switch (decision.action) {
    case 'send_recovery': {
      if (!decision.message || decision.message.length < 5) {
        logger.warn(
          { conversationId: ctx.conversationId },
          '[Followup] send_recovery mas message vazia - voltando pra idle',
        );
        await db
          .update(conversations)
          .set({ followupState: 'idle' })
          .where(eq(conversations.id, ctx.conversationId));
        return;
      }

      // RACE B4 fix: claim final ATOMICO. Se cliente respondeu durante o LLM call,
      // resetFollowupOnUserReply ja mudou state pra 'idle'. Tentamos atomicamente
      // setar 'sent' SO se state ainda for 'scheduled'. Se voltar vazio: aborta.
      const transitioned = await db
        .update(conversations)
        .set({
          followupState: 'sent',
          followupAttempts: sql`${conversations.followupAttempts} + 1`,
          followupTotalAttempts: sql`${conversations.followupTotalAttempts} + 1`,
          followupLastAttemptAt: new Date(),
          // DANI esta retomando a conversa via follow-up -> volta pro modo nina
          // e zera o cooldown humano, pra que a resposta do cliente seja atendida.
          status: 'nina',
          lastHumanAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(conversations.id, ctx.conversationId),
            eq(conversations.followupState, 'scheduled'),
            // M2: NAO derruba a Bia se ela assumiu durante a janela do LLM
            // (segundos). So reativa/envia se a Bia NAO respondeu nos ultimos
            // 2min. Recovery de 'human' abandonado (>4h) passa normal; Bia
            // que acabou de assumir (lastHumanAt recente) aborta o follow-up.
            sql`(${conversations.lastHumanAt} IS NULL OR ${conversations.lastHumanAt} < NOW() - INTERVAL '2 minutes')`,
          ),
        )
        .returning({ id: conversations.id, attempts: conversations.followupAttempts });

      if (transitioned.length === 0) {
        logger.info(
          { conversationId: ctx.conversationId },
          '[Followup] race: cliente/Bia respondeu durante LLM - abortando recovery',
        );
        return;
      }

      // Agora sim - salva mensagem e enfileira envio
      const { saveMessage } = await import('./dani-conversations.js');
      const { outboundQueue } = await import('./queues.js');

      await saveMessage({
        conversationId: ctx.conversationId,
        accountId: ctx.accountId,
        fromType: 'nina',
        content: decision.message,
        processedByNina: true,
      });

      await outboundQueue.add(
        'send',
        {
          accountId: ctx.accountId,
          phoneNumber: ctx.contactPhone,
          text: decision.message,
          conversationId: ctx.conversationId,
        },
        {
          jobId: `followup-send_${ctx.conversationId}_${transitioned[0].attempts}`,
        },
      );

      logger.info(
        {
          conversationId: ctx.conversationId,
          attempt: transitioned[0].attempts,
          reasoning: decision.reasoning,
        },
        '[Followup] recovery sent',
      );
      break;
    }

    case 'close_conversation': {
      await db
        .update(conversations)
        .set({
          status: 'closed',
          followupState: 'closed',
          updatedAt: new Date(),
        })
        .where(eq(conversations.id, ctx.conversationId));
      logger.info(
        { conversationId: ctx.conversationId, reasoning: decision.reasoning },
        '[Followup] conversation closed',
      );
      break;
    }

    case 'stay_silent': {
      await db
        .update(conversations)
        .set({
          followupState: 'declined',
          updatedAt: new Date(),
        })
        .where(eq(conversations.id, ctx.conversationId));
      logger.debug(
        { conversationId: ctx.conversationId, reasoning: decision.reasoning },
        '[Followup] stay_silent',
      );
      break;
    }

    case 'wait_more': {
      // Volta pra idle pro proximo tick reavaliar
      await db
        .update(conversations)
        .set({ followupState: 'idle' })
        .where(eq(conversations.id, ctx.conversationId));
      logger.debug(
        { conversationId: ctx.conversationId, reasoning: decision.reasoning },
        '[Followup] wait_more',
      );
      break;
    }
  }
}

/**
 * Reset follow-up state quando cliente responde.
 *
 * Estado SEMPRE volta pra 'idle' (libera pra proximo tick reavaliar).
 *
 * followupAttempts (contador do ciclo atual) so zera se cliente respondeu
 * com mensagem SUBSTANTIVA (>20 chars). Resposta "oi" / "ok" / emoji nao
 * zera — evita loop infinito (cliente "oi" -> 2 recoveries -> "oi" -> +2...).
 *
 * followupTotalAttempts NUNCA reseta - cap absoluto MAX_TOTAL_ATTEMPTS (6).
 */
export async function resetFollowupOnUserReply(
  conversationId: string,
  userMessage?: string,
): Promise<void> {
  const isSubstantive =
    !!userMessage && userMessage.trim().length >= SUBSTANTIVE_REPLY_MIN_CHARS;

  // Le o estado atual: se a DANI mandou follow-up (sent) e a conversa esta
  // travada em 'human', o cliente esta respondendo a DANI -> ela deve retomar
  // o atendimento (sai do cooldown humano) e responder.
  const [conv] = await db
    .select({ followupState: conversations.followupState, status: conversations.status })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);

  const wasFollowupSent = conv?.followupState === 'sent';
  const reactivateDani = wasFollowupSent && conv?.status === 'human';

  // Rosana (regra nova): APENAS 1 abordagem se o cliente RESPONDER. Se a DANI ja
  // mandou follow-up (state='sent') e o cliente respondeu — ATE pra dizer "nao" —
  // ENCERRA o follow-up (state='declined') e NUNCA reaborda de novo. Antes
  // resetava os attempts e reabordava 2-3x (o que a Rosana detestou). A DANI
  // ainda responde a mensagem VIVA do cliente (reactivateDani); so o PROATIVO
  // para. Quem fica em SILENCIO trava em 'sent' (1 abordagem) — dentro do "max 2".
  void isSubstantive; // a regra nao depende mais do tamanho da resposta
  const newState = wasFollowupSent ? ('declined' as const) : ('idle' as const);

  await db
    .update(conversations)
    .set({
      followupState: newState,
      ...(reactivateDani ? { status: 'nina' as const, lastHumanAt: null } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(conversations.id, conversationId),
        sql`${conversations.followupState} IN ('sent', 'scheduled')`,
      ),
    );

  if (reactivateDani) {
    logger.info(
      { conversationId },
      '[Followup] cliente respondeu follow-up -> DANI reativada (sai do cooldown humano)',
    );
  }
  if (wasFollowupSent) {
    logger.debug(
      { conversationId },
      '[Followup] cliente respondeu o follow-up -> encerrado (declined), nao reaborda mais',
    );
  }
}
