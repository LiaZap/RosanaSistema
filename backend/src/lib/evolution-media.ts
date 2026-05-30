import { getEvolutionSettings } from './evolution-client.js';
import { logger } from './logger.js';

/**
 * Sprint 3 - Baixa media (imagem/audio/doc) recebida pelo webhook do Evolution
 * pra alimentar o classificador Gemini Vision.
 *
 * Evolution v2 expõe POST /chat/getBase64FromMediaMessage/{instance}
 * que retorna base64 + mimetype a partir do message_id.
 */

const MAX_BYTES = 8 * 1024 * 1024; // 8MB cap

export interface EvolutionMediaResult {
  base64: string;
  mimetype: string;
  bytes: number;
}

export async function fetchMessageMediaBase64(opts: {
  accountId: string;
  instanceName: string;
  messageKey: { id: string; remoteJid: string; fromMe: boolean };
}): Promise<EvolutionMediaResult | null> {
  const settings = await getEvolutionSettings(opts.accountId);

  const res = await fetch(
    `${settings.apiUrl}/chat/getBase64FromMediaMessage/${opts.instanceName}`,
    {
      method: 'POST',
      headers: {
        apikey: settings.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: { key: opts.messageKey },
        convertToMp4: false,
      }),
    },
  );

  if (!res.ok) {
    logger.warn(
      { status: res.status, messageId: opts.messageKey.id },
      '[EvolutionMedia] fetch failed',
    );
    return null;
  }

  const json = (await res.json()) as {
    base64?: string;
    mediaType?: string;
    mimetype?: string;
    fileName?: string;
  };

  if (!json.base64) {
    logger.warn({ messageId: opts.messageKey.id }, '[EvolutionMedia] no base64 in response');
    return null;
  }

  const mimetype = json.mimetype ?? json.mediaType ?? 'application/octet-stream';
  // Aproxima bytes: base64 length * 0.75
  const bytes = Math.floor(json.base64.length * 0.75);

  if (bytes > MAX_BYTES) {
    logger.warn(
      { messageId: opts.messageKey.id, bytes, accountId: opts.accountId },
      '[EvolutionMedia] media too large, rejecting',
    );
    return null;
  }

  return { base64: json.base64, mimetype, bytes };
}
