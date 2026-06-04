import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Assinatura de URLs de midia privada servidas por /media/asset e /media/chat.
 *
 * Por que existe: essas rotas servem midia por-conta (imagens de chat, arquivos
 * de biblioteca, avatares) por uma key opaca no MinIO. Sem assinatura, qualquer
 * um que descubra/adivinhe a key baixa o arquivo (IDOR cross-tenant).
 *
 * Por que NAO usamos requireAuth por cookie: os consumidores legitimos sao
 * cookie-less / cross-origin e quebrariam com auth de sessao:
 *  - Evolution API busca a URL server-side pra enviar midia no WhatsApp
 *    (sendMediaMessage passa `media: <url>` e o Evolution faz o GET).
 *  - <img> de avatar carrega cross-origin no frontend (cookie SameSite=lax
 *    nao acompanha subrequest de imagem cross-site).
 *
 * Solucao: HMAC-SHA256(secret, key) deterministico (sem expiracao) anexado como
 * ?sig=. Deterministico => URLs estaveis, cacheaveis e backfillaveis. Propriedade
 * de seguranca: nao da pra forjar uma URL pra uma key arbitraria sem o secret.
 *
 * Secret: usa MEDIA_SIGNING_SECRET se setado; senao deriva do MINIO_ROOT_PASSWORD
 * (presente em qualquer deploy onde a midia ja funciona). PRECISA ser identico em
 * todos os processos (signer/verifier/backfill) e estavel no tempo — e
 * deterministico por env, entao defina ANTES do primeiro boot e nao troque
 * (trocar invalida todas as URLs ja assinadas/salvas).
 */
const SECRET =
  process.env.MEDIA_SIGNING_SECRET ||
  process.env.MINIO_ROOT_PASSWORD ||
  'fce-media-signing-dev';

const SIG_LEN = 32; // 16 bytes em hex: curto pra URL, forte o bastante

/** Assina uma key crua (ja decodificada) do MinIO. Retorna hex truncado. */
export function signMediaKey(key: string): string {
  return createHmac('sha256', SECRET).update(key).digest('hex').slice(0, SIG_LEN);
}

/** Verifica a assinatura em tempo constante. false se ausente ou invalida. */
export function verifyMediaSig(key: string, sig: string | null | undefined): boolean {
  if (!sig || sig.length !== SIG_LEN) return false;
  const a = Buffer.from(sig);
  const b = Buffer.from(signMediaKey(key));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Anexa ?sig=<assinatura da rawKey> a uma URL de midia ja montada.
 * `url` ja contem a key URL-encoded no path; `rawKey` e a key crua que sera
 * assinada e que o verificador recompoe via decodeURIComponent(param('key')).
 */
export function appendMediaSig(url: string, rawKey: string): string {
  const sig = signMediaKey(rawKey);
  return `${url}${url.includes('?') ? '&' : '?'}sig=${sig}`;
}
