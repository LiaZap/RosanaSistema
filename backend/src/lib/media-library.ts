import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { mediaLibrary } from '../db/schema.js';
import { logger } from './logger.js';

/**
 * Sprint 4 - Media Library.
 *
 * Repositorio de PDFs, videos, audios que a DANI envia via WhatsApp
 * quando cliente pede catalogo, video demo, etc.
 *
 * Tool 'enviar_arquivo' busca aqui (nao no Bling).
 */

export function normalizeForSearch(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface MediaItem {
  id: string;
  name: string;
  description: string | null;
  fileUrl: string;
  fileType: string;
  fileSize: number | null;
  tags: string[];
}

/**
 * Busca itens da media library por nome/tags.
 * Score: exact match 100, prefix 50, contains 30. Bonus: tag hit +30.
 */
export async function buscarMidia(opts: {
  accountId: string;
  consulta: string;
  limit?: number;
}): Promise<MediaItem[]> {
  const limit = opts.limit ?? 5;
  const q = normalizeForSearch(opts.consulta);
  if (!q) return [];

  // Carrega candidatos com any match em name_normalized ou tags
  const rows = await db
    .select()
    .from(mediaLibrary)
    .where(
      and(
        eq(mediaLibrary.accountId, opts.accountId),
        sql`(${mediaLibrary.nameNormalized} ilike ${`%${q}%`} OR ${mediaLibrary.description} ilike ${`%${q}%`})`,
      ),
    )
    .orderBy(desc(mediaLibrary.useCount), desc(mediaLibrary.createdAt))
    .limit(limit * 2);

  // Score em JS pra simplicidade
  const scored = rows.map((r) => {
    const nameN = r.nameNormalized ?? '';
    let score = 0;
    if (nameN === q) score = 100;
    else if (nameN.startsWith(q)) score = 50;
    else if (nameN.includes(q)) score = 30;

    const tags = (r.tags ?? []) as string[];
    if (tags.some((t) => t.toLowerCase().includes(q))) score += 30;

    return {
      item: {
        id: r.id,
        name: r.name,
        description: r.description,
        fileUrl: r.fileUrl,
        fileType: r.fileType,
        fileSize: r.fileSize,
        tags,
      } satisfies MediaItem,
      score,
    };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.item);
}

/** Bump use_count + last_used_at quando DANI envia */
export async function trackUse(mediaId: string): Promise<void> {
  await db
    .update(mediaLibrary)
    .set({
      useCount: sql`${mediaLibrary.useCount} + 1`,
      lastUsedAt: new Date(),
    })
    .where(eq(mediaLibrary.id, mediaId))
    .catch((err) => logger.warn({ err: (err as Error).message }, '[MediaLib] trackUse failed'));
}
