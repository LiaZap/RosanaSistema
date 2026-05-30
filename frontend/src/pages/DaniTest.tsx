import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import AppShell from '../components/AppShell';

interface MeResponse {
  user: { id: string; email: string };
  accounts: Array<{ accountId: string; role: string; accountName: string }>;
}

interface ToolCallInfo {
  name: string;
  args: Record<string, unknown>;
}

interface DaniAttachment {
  type: 'image';
  url: string;
  caption?: string;
}

interface ChatTurn {
  role: 'user' | 'model';
  text: string;
  attachments?: DaniAttachment[];
  meta?: {
    modelMode: string;
    durationMs: number;
    fillerStripped: boolean;
    iterations?: number;
    toolCalls?: ToolCallInfo[];
  };
}

interface MessagesResponse {
  messages: Array<{ id: string; role: 'user' | 'model'; text: string; createdAt: string }>;
}

const CONV_STORAGE_KEY = 'fce_dani_conversation_id';

function ImageAttachment({ url, alt }: { url: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  // URLs relativas (/media/file/:id ou /media/proxy) vao via /api (nginx)
  // URLs absolutas Cloudinary vao direto
  // URLs absolutas Bling/outros vao via proxy
  const src = url.startsWith('/media/')
    ? `/api${url}`
    : url.includes('res.cloudinary.com')
    ? url
    : `/api/media/proxy?url=${encodeURIComponent(url)}`;

  if (failed) {
    return (
      <div className="rounded-lg mb-2 -mx-1 max-w-[280px] bg-muted/60 border border-border p-3 text-xs">
        <p className="text-muted-foreground mb-1">Nao consegui carregar a imagem aqui</p>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary hover:underline break-all font-mono text-[10px]"
        >
          Abrir foto em nova aba ↗
        </a>
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      className="rounded-lg mb-2 -mx-1 max-w-[280px] bg-muted"
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

export default function DaniTestPage() {
  const navigate = useNavigate();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [accountId, setAccountId] = useState<string>('');
  const [conversationId, setConversationId] = useState<string | null>(
    () => localStorage.getItem(CONV_STORAGE_KEY),
  );
  const [input, setInput] = useState('');
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [sending, setSending] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  // Carrega user
  useEffect(() => {
    api
      .get<MeResponse>('/auth/me')
      .then((data) => {
        setMe(data);
        if (data.accounts[0]) setAccountId(data.accounts[0].accountId);
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) navigate('/auth');
      });
  }, [navigate]);

  // Carrega histórico da conversa salva no localStorage
  useEffect(() => {
    if (!accountId || !conversationId) return;
    setLoadingHistory(true);
    api
      .get<MessagesResponse>(`/dani/conversations/${conversationId}/messages?accountId=${accountId}`)
      .then((data) => {
        setTurns(data.messages.map((m) => ({ role: m.role, text: m.text })));
      })
      .catch((e) => {
        if (e instanceof ApiError && (e.status === 404 || e.status === 401)) {
          // Conversa nao existe mais (ou nao tem permissao) - limpa
          localStorage.removeItem(CONV_STORAGE_KEY);
          setConversationId(null);
        }
      })
      .finally(() => setLoadingHistory(false));
  }, [accountId, conversationId]);

  // Auto-scroll
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns]);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || !accountId || sending) return;
    const userText = input.trim();
    setInput('');
    setError(null);

    const newTurns: ChatTurn[] = [...turns, { role: 'user', text: userText }];
    setTurns(newTurns);
    setSending(true);

    try {
      const res = await api.post<{
        reply: string;
        conversationId: string;
        attachments?: DaniAttachment[];
        meta: {
          modelMode: string;
          durationMs: number;
          fillerStripped: boolean;
          iterations: number;
          toolCalls: ToolCallInfo[];
        };
      }>('/dani/chat', {
        accountId,
        message: userText,
        conversationId: conversationId ?? undefined,
      });

      // Persiste conversationId retornado
      if (res.conversationId !== conversationId) {
        localStorage.setItem(CONV_STORAGE_KEY, res.conversationId);
        setConversationId(res.conversationId);
      }

      setTurns([
        ...newTurns,
        { role: 'model', text: res.reply, meta: res.meta, attachments: res.attachments },
      ]);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Erro desconhecido';
      setError(msg);
      setTurns(turns); // rollback
    } finally {
      setSending(false);
    }
  }

  async function handleNewConversation() {
    if (!accountId) return;
    try {
      const res = await api.post<{ conversationId: string }>('/dani/conversations', { accountId });
      localStorage.setItem(CONV_STORAGE_KEY, res.conversationId);
      setConversationId(res.conversationId);
      setTurns([]);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao criar conversa');
    }
  }

  void me;
  return (
    <AppShell
      title="DANI - Teste"
      subtitle={conversationId ? `conv ${conversationId.slice(0, 8)}...` : 'sem conversa'}
      actions={
        <button
          onClick={handleNewConversation}
          className="px-3 py-2 rounded-lg border border-border text-sm
                     text-muted-foreground hover:bg-card transition-colors"
        >
          Nova conversa
        </button>
      }
    >
      <div className="space-y-6 max-w-3xl mx-auto">

        {/* Chat */}
        <div className="glass rounded-xl p-5 min-h-[400px] max-h-[60vh] overflow-y-auto space-y-3">
          {loadingHistory && (
            <p className="text-muted-foreground text-sm text-center py-12">
              Carregando histórico...
            </p>
          )}
          {!loadingHistory && turns.length === 0 && (
            <p className="text-muted-foreground text-sm text-center py-12">
              Mande uma mensagem pra DANI testar o orchestrator
            </p>
          )}
          {turns.map((t, i) => (
            <div
              key={i}
              className={`flex ${t.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[80%] rounded-xl px-4 py-2.5 text-sm whitespace-pre-wrap overflow-hidden ${
                  t.role === 'user'
                    ? 'gradient-pink text-white'
                    : 'bg-card border border-border text-foreground'
                }`}
              >
                {/* Attachments - proxy via backend pra burlar hot-link */}
                {t.attachments?.map((att, ai) =>
                  att.type === 'image' ? (
                    <ImageAttachment key={ai} url={att.url} alt={att.caption ?? 'produto'} />
                  ) : null,
                )}
                {t.text}
                {t.meta && (
                  <div className="mt-1.5 pt-1.5 border-t border-white/10 text-[10px] opacity-60 space-y-0.5">
                    <div>
                      {t.meta.modelMode} · {t.meta.durationMs}ms
                      {t.meta.iterations && t.meta.iterations > 1 ? ` · ${t.meta.iterations} loops` : ''}
                      {t.meta.fillerStripped ? ' · filler stripped' : ''}
                    </div>
                    {t.meta.toolCalls && t.meta.toolCalls.length > 0 && (
                      <div className="font-mono">
                        🔧 {t.meta.toolCalls
                          .map((tc) => `${tc.name}(${JSON.stringify(tc.args)})`)
                          .join(', ')}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
          {sending && (
            <div className="flex justify-start">
              <div className="bg-card border border-border rounded-xl px-4 py-2.5 text-sm text-muted-foreground">
                ...
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>

        {error && (
          <div className="rounded-lg border border-fce-red/40 bg-fce-red/10 p-3 text-sm text-fce-red">
            {error}
          </div>
        )}

        {/* Input */}
        <form onSubmit={handleSend} className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={sending || !accountId}
            placeholder="Oi DANI, queria ver os precos do Windi..."
            className="flex-1 px-4 py-3 rounded-lg bg-card border border-border
                       text-foreground placeholder:text-muted-foreground
                       focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <button
            type="submit"
            disabled={sending || !input.trim() || !accountId}
            className="px-6 py-3 rounded-lg gradient-pink text-white font-semibold
                       disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Enviar
          </button>
        </form>
      </div>
    </AppShell>
  );
}
