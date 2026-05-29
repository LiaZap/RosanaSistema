import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';

interface MeResponse {
  user: { id: string; email: string };
  accounts: Array<{ accountId: string; role: string; accountName: string }>;
}

interface Message {
  id: string;
  fromType: 'user' | 'nina' | 'human';
  content: string | null;
  messageType: string;
  createdAt: string;
  processedByNina: boolean;
}

interface Conversation {
  id: string;
  status: 'nina' | 'human' | 'paused' | 'closed';
  contact: {
    id: string;
    name: string | null;
    phoneNumber: string;
    tags: string[] | null;
  } | null;
}

interface DetailResponse {
  conversation: Conversation;
  messages: Message[];
}

const STATUS_LABELS: Record<Conversation['status'], string> = {
  nina: 'DANI atendendo',
  human: 'Humano atendendo',
  paused: 'Pausado',
  closed: 'Fechado',
};

const STATUS_COLORS: Record<Conversation['status'], string> = {
  nina: 'bg-fce-pink/20 text-fce-pink border-fce-pink/40',
  human: 'bg-fce-green/20 text-fce-green border-fce-green/40',
  paused: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/40',
  closed: 'bg-muted text-muted-foreground border-border',
};

export default function ConversationDetailPage() {
  const navigate = useNavigate();
  const { id: conversationId } = useParams<{ id: string }>();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [accountId, setAccountId] = useState<string>('');
  const [detail, setDetail] = useState<DetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

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

  async function loadDetail() {
    if (!accountId || !conversationId) return;
    try {
      const data = await api.get<DetailResponse>(
        `/crm/conversations/${conversationId}?accountId=${accountId}`,
      );
      setDetail(data);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao carregar');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadDetail();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, conversationId]);

  // Auto refresh
  useEffect(() => {
    if (!accountId || !conversationId) return;
    const interval = setInterval(() => loadDetail(), 8000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, conversationId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [detail?.messages.length]);

  async function changeStatus(status: Conversation['status']) {
    if (!accountId || !conversationId) return;
    setError(null);
    try {
      await api.patch(`/crm/conversations/${conversationId}?accountId=${accountId}`, { status });
      await loadDetail();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao mudar status');
    }
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || sending || !accountId || !conversationId) return;
    setSending(true);
    setError(null);
    try {
      await api.post(`/crm/conversations/${conversationId}/messages?accountId=${accountId}`, {
        content: input.trim(),
      });
      setInput('');
      await loadDetail();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao enviar');
    } finally {
      setSending(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-muted-foreground text-sm">Carregando...</div>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-background gap-3">
        <p className="text-muted-foreground text-sm">Conversa nao encontrada</p>
        <Link to="/conversations" className="text-fce-pink text-sm">
          Voltar pra lista
        </Link>
      </div>
    );
  }

  const { conversation, messages } = detail;
  const isHumanMode = conversation.status === 'human';
  const isClosed = conversation.status === 'closed';

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <div className="border-b border-border bg-background/80 backdrop-blur p-4 sticky top-0 z-10">
        <div className="max-w-3xl mx-auto flex items-center justify-between gap-3">
          <Link
            to="/conversations"
            className="text-muted-foreground hover:text-foreground text-sm"
          >
            ← Lista
          </Link>
          <div className="flex-1 text-center">
            <div className="font-semibold text-foreground">
              {conversation.contact?.name ?? conversation.contact?.phoneNumber ?? 'Sem contato'}
            </div>
            <div className="text-xs text-muted-foreground font-mono">
              {conversation.contact?.phoneNumber}
            </div>
          </div>
          <span
            className={`text-[10px] px-2 py-1 rounded border ${STATUS_COLORS[conversation.status]}`}
          >
            {STATUS_LABELS[conversation.status]}
          </span>
        </div>
      </div>

      {/* Action bar */}
      <div className="border-b border-border bg-card/30 p-3">
        <div className="max-w-3xl mx-auto flex gap-2 justify-center flex-wrap">
          {conversation.status !== 'human' && (
            <button
              onClick={() => changeStatus('human')}
              className="px-3 py-1.5 rounded-lg gradient-pink text-white text-xs font-semibold"
            >
              Assumir
            </button>
          )}
          {conversation.status === 'human' && (
            <button
              onClick={() => changeStatus('nina')}
              className="px-3 py-1.5 rounded-lg border border-border text-xs text-foreground hover:bg-card"
            >
              Devolver pra DANI
            </button>
          )}
          {conversation.status !== 'paused' && conversation.status !== 'closed' && (
            <button
              onClick={() => changeStatus('paused')}
              className="px-3 py-1.5 rounded-lg border border-border text-xs text-foreground hover:bg-card"
            >
              Pausar
            </button>
          )}
          {conversation.status !== 'closed' && (
            <button
              onClick={() => changeStatus('closed')}
              className="px-3 py-1.5 rounded-lg border border-fce-red/40 text-fce-red text-xs hover:bg-fce-red/10"
            >
              Fechar
            </button>
          )}
          {conversation.status === 'closed' && (
            <button
              onClick={() => changeStatus('nina')}
              className="px-3 py-1.5 rounded-lg border border-border text-xs text-foreground hover:bg-card"
            >
              Reabrir
            </button>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="max-w-3xl mx-auto space-y-3">
          {messages.length === 0 && (
            <p className="text-center text-muted-foreground text-sm py-12">
              Nenhuma mensagem ainda
            </p>
          )}
          {messages.map((m) => {
            const isClient = m.fromType === 'user';
            const isDani = m.fromType === 'nina';
            return (
              <div key={m.id} className={`flex ${isClient ? 'justify-start' : 'justify-end'}`}>
                <div
                  className={`max-w-[75%] rounded-xl px-3.5 py-2 text-sm whitespace-pre-wrap ${
                    isClient
                      ? 'bg-card border border-border text-foreground'
                      : isDani
                      ? 'gradient-pink text-white'
                      : 'bg-fce-green text-white'
                  }`}
                >
                  {m.content ?? `[${m.messageType}]`}
                  <div className="text-[10px] opacity-60 mt-1">
                    {new Date(m.createdAt).toLocaleString('pt-BR', {
                      hour: '2-digit',
                      minute: '2-digit',
                      day: '2-digit',
                      month: '2-digit',
                    })}
                    {isDani && ' · DANI'}
                    {m.fromType === 'human' && ' · Humano'}
                  </div>
                </div>
              </div>
            );
          })}
          <div ref={endRef} />
        </div>
      </div>

      {/* Input */}
      <div className="border-t border-border bg-background p-3 sticky bottom-0">
        <div className="max-w-3xl mx-auto">
          {!isHumanMode && !isClosed && (
            <p className="text-xs text-muted-foreground text-center mb-2">
              ⓘ Assuma a conversa pra responder manualmente. DANI esta no comando.
            </p>
          )}
          {error && (
            <div className="rounded-lg border border-fce-red/40 bg-fce-red/10 p-2 mb-2 text-xs text-fce-red">
              {error}
            </div>
          )}
          <form onSubmit={handleSend} className="flex gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={!isHumanMode || isClosed || sending}
              placeholder={
                isClosed
                  ? 'Conversa fechada'
                  : isHumanMode
                  ? 'Responder como humano...'
                  : 'Assuma pra responder'
              }
              className="flex-1 px-3 py-2.5 rounded-lg bg-card border border-border
                         text-foreground placeholder:text-muted-foreground text-sm
                         focus:outline-none focus:ring-2 focus:ring-ring
                         disabled:opacity-60"
            />
            <button
              type="submit"
              disabled={!isHumanMode || isClosed || sending || !input.trim()}
              className="px-5 py-2.5 rounded-lg gradient-pink text-white text-sm font-semibold
                         disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {sending ? '...' : 'Enviar'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
