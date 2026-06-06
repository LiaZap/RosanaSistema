import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import AppShell from '../components/AppShell';
import { Avatar } from '../components/ui/avatar';
import { DaniAvatar } from '../components/ui/DaniAvatar';

interface MeResponse {
  user: { id: string; email: string };
  accounts: Array<{ accountId: string; role: string; accountName: string }>;
}

interface Message {
  id: string;
  fromType: 'user' | 'nina' | 'human';
  content: string | null;
  messageType: string;
  mediaUrl?: string | null;
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
  hasMore?: boolean;
}

interface OlderMessagesResponse {
  messages: Message[];
  hasMore: boolean;
}

interface Analysis {
  summary: string;
  intent: string;
  sentiment: 'positivo' | 'neutro' | 'negativo';
  qualification: 'frio' | 'morno' | 'quente';
  topics: string[];
  next_steps: string[];
  flags: {
    needs_human: boolean;
    needs_appointment: boolean;
    customer_unhappy: boolean;
  };
}

const STATUS_LABELS: Record<Conversation['status'], string> = {
  nina: 'DANI atendendo',
  human: 'Humano atendendo',
  paused: 'Pausado',
  closed: 'Fechado',
};

const STATUS_BADGE: Record<Conversation['status'], string> = {
  nina: 'badge-brand',
  human: 'badge-success',
  paused: 'badge-warning',
  closed: 'badge-neutral',
};

const STATUS_DOT: Record<Conversation['status'], string> = {
  nina: 'bg-primary',
  human: 'bg-fce-green',
  paused: 'bg-yellow-500',
  closed: 'bg-muted-foreground',
};

export default function ConversationDetailPage({
  idProp,
  embedded = false,
  onBack,
}: {
  idProp?: string;
  embedded?: boolean;
  onBack?: () => void;
} = {}) {
  const navigate = useNavigate();
  const params = useParams<{ id: string }>();
  const conversationId = idProp ?? params.id;
  const [me, setMe] = useState<MeResponse | null>(null);
  const [accountId, setAccountId] = useState<string>('');
  const [detail, setDetail] = useState<DetailResponse | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const nearBottomRef = useRef(true);
  const initialScrollDoneRef = useRef(false); // ja fez o scroll inicial pro fim?
  const prependingRef = useRef(false); // loadOlder esta prependendo (nao scrollar pro fim)
  const settlingUntilRef = useRef(0); // timestamp ate quando "grudar no fim" (assentamento inicial)

  // Quick actions: modais de Deal e Appointment
  const [showDealModal, setShowDealModal] = useState(false);
  const [showApptModal, setShowApptModal] = useState(false);
  const [dealForm, setDealForm] = useState({ title: '', value: '', notes: '' });
  const [apptForm, setApptForm] = useState({
    title: '',
    date: '',
    time: '14:00',
    duration: 60,
    type: 'consultation',
    description: '',
  });
  const [quickSaving, setQuickSaving] = useState(false);

  // Analysis IA
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [showAnalysis, setShowAnalysis] = useState(false);

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

  async function loadDetail(initial = false) {
    if (!accountId || !conversationId) return;
    try {
      const data = await api.get<DetailResponse>(
        `/crm/conversations/${conversationId}?accountId=${accountId}`,
      );
      setDetail(data);
      if (initial) {
        setMessages(data.messages);
        setHasMore(!!data.hasMore);
      } else {
        // Poll: mescla so mensagens novas no fim (preserva antigas carregadas)
        setMessages((prev) => {
          const ids = new Set(prev.map((m) => m.id));
          const incoming = data.messages.filter((m) => !ids.has(m.id));
          return incoming.length ? [...prev, ...incoming] : prev;
        });
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao carregar');
    } finally {
      setLoading(false);
    }
  }

  // Carrega mensagens ANTIGAS (scroll pra cima). Preserva posicao do scroll.
  async function loadOlder() {
    const el = scrollRef.current;
    if (!el || loadingOlder || !hasMore || messages.length === 0 || !accountId || !conversationId) return;
    setLoadingOlder(true);
    const oldest = messages[0]!;
    const prevHeight = el.scrollHeight;
    try {
      const data = await api.get<OlderMessagesResponse>(
        `/crm/conversations/${conversationId}/messages?accountId=${accountId}&before=${encodeURIComponent(oldest.createdAt)}&limit=30`,
      );
      prependingRef.current = true; // sinaliza pro effect NAO scrollar pro fim
      setMessages((prev) => {
        const ids = new Set(prev.map((m) => m.id));
        const older = data.messages.filter((m) => !ids.has(m.id));
        if (older.length === 0) return prev;
        return [...older, ...prev];
      });
      setHasMore(data.hasMore);
      // Restaura posicao: mantem a mensagem que estava no topo visivel
      requestAnimationFrame(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight - prevHeight;
        }
      });
    } catch {
      // ignore
    } finally {
      setLoadingOlder(false);
    }
  }

  // Carga inicial (reseta ao trocar de conversa)
  useEffect(() => {
    setMessages([]);
    setHasMore(false);
    nearBottomRef.current = true;
    initialScrollDoneRef.current = false;
    prependingRef.current = false;
    setLoading(true);
    loadDetail(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, conversationId]);

  // Auto refresh (poll mescla novas)
  useEffect(() => {
    if (!accountId || !conversationId) return;
    const interval = setInterval(() => loadDetail(false), 8000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, conversationId]);

  // Gerencia o scroll quando a lista de mensagens muda ou o loading termina.
  // useLayoutEffect roda ANTES do paint -> o scroll ja aparece no lugar certo
  // (sem flash no topo).
  // - Primeira carga: pula direto pro FIM (scrollTop = scrollHeight) com duplo
  //   requestAnimationFrame de reforco pra cobrir layout assincrono
  // - Prepend (loadOlder): NAO mexe (o loadOlder restaura a posicao)
  // - Nova msg do poll: scrolla pro fim SO se o usuario ja estava perto do fim
  useLayoutEffect(() => {
    if (loading) return;
    const el = scrollRef.current;
    if (!el || messages.length === 0) return;

    const toBottom = () => {
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    };

    if (!initialScrollDoneRef.current) {
      initialScrollDoneRef.current = true;
      nearBottomRef.current = true;
      // Gruda no FIM por uma janela de "assentamento" (~1.2s) cobrindo conteudo
      // async (imagens, fontes, layout). Enquanto isso o loadOlder fica
      // BLOQUEADO (ver handleScroll) pra nao entrar em loop de "subir +
      // recarregar mensagem". Cada frame reforca scrollTop = scrollHeight.
      settlingUntilRef.current = Date.now() + 1200;
      const stick = () => {
        if (!scrollRef.current) return;
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        if (Date.now() < settlingUntilRef.current) requestAnimationFrame(stick);
      };
      stick();
      return;
    }
    if (prependingRef.current) {
      prependingRef.current = false; // loadOlder cuida da posicao
      return;
    }
    if (nearBottomRef.current) {
      toBottom();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, loading]);

  // Imagens (foto de produto, mídia) carregam DEPOIS do render e empurram o
  // conteudo, fazendo o scroll "subir" sozinho ("sobe pro inicio"). Quando uma
  // <img> dentro do chat termina de carregar, re-ancora no FIM se o usuario
  // estava perto do fim. O evento 'load' de img NAO borbulha -> capturamos na
  // fase de captura (3o arg = true). Nao interfere com loadOlder (prependingRef)
  // nem com quem rolou pra cima lendo historico (nearBottomRef = false).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onImgLoad = (e: Event) => {
      const t = e.target as HTMLElement | null;
      if (!t || t.tagName !== 'IMG') return;
      if (nearBottomRef.current && !prependingRef.current) {
        requestAnimationFrame(() => {
          if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        });
      }
    };
    el.addEventListener('load', onImgLoad, true);
    return () => el.removeEventListener('load', onImgLoad, true);
  }, []);

  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    // Nao reage a scroll antes do scroll inicial (evita loop de loadOlder no mount)
    if (!initialScrollDoneRef.current) return;
    // Durante a janela de assentamento, gruda no fim e NAO dispara loadOlder
    // (e isto que matava o loop de "fica subindo e recarregando").
    if (Date.now() < settlingUntilRef.current) {
      el.scrollTop = el.scrollHeight;
      return;
    }
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
    if (el.scrollTop < 60 && hasMore && !loadingOlder) {
      loadOlder();
    }
  }

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

  async function handleCreateDeal(e: React.FormEvent) {
    e.preventDefault();
    if (!accountId || !detail?.conversation.contact || !dealForm.title) return;
    setQuickSaving(true);
    setError(null);
    try {
      await api.post('/pipeline/deals', {
        accountId,
        contactId: detail.conversation.contact.id,
        title: dealForm.title,
        value: dealForm.value ? Number(dealForm.value) : undefined,
        notes: dealForm.notes || undefined,
      });
      setShowDealModal(false);
      setDealForm({ title: '', value: '', notes: '' });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao criar deal');
    } finally {
      setQuickSaving(false);
    }
  }

  async function handleCreateAppt(e: React.FormEvent) {
    e.preventDefault();
    if (!accountId || !detail?.conversation.contact || !apptForm.title || !apptForm.date) return;
    setQuickSaving(true);
    setError(null);
    try {
      const dt = new Date(`${apptForm.date}T${apptForm.time}:00`);
      await api.post('/appointments', {
        accountId,
        contactId: detail.conversation.contact.id,
        title: apptForm.title,
        date: dt.toISOString(),
        time: apptForm.time,
        duration: apptForm.duration,
        type: apptForm.type,
        description: apptForm.description || undefined,
      });
      setShowApptModal(false);
      setApptForm({
        title: '',
        date: '',
        time: '14:00',
        duration: 60,
        type: 'consultation',
        description: '',
      });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao agendar');
    } finally {
      setQuickSaving(false);
    }
  }

  async function handleAnalyze() {
    if (!accountId || !conversationId) return;
    setAnalyzing(true);
    setError(null);
    try {
      const data = await api.post<{ analysis: Analysis }>(
        `/crm/conversations/${conversationId}/analyze?accountId=${accountId}`,
      );
      setAnalysis(data.analysis);
      setShowAnalysis(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao analisar');
    } finally {
      setAnalyzing(false);
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

  // Frame: em modo embedded renderiza painel simples (sem AppShell, pra
  // viver dentro do split-pane de Conversas). Senao usa AppShell completo.
  const Frame = ({
    title,
    subtitle,
    actions,
    children,
  }: {
    title: string;
    subtitle?: string;
    actions?: React.ReactNode;
    children: React.ReactNode;
  }) => {
    if (!embedded) {
      return (
        <AppShell title={title} subtitle={subtitle} actions={actions} bare>
          {children}
        </AppShell>
      );
    }
    return (
      <div className="flex flex-col h-full min-h-0">
        <div
          className="flex items-center gap-3 px-4 py-2.5 border-b shrink-0"
          style={{ borderColor: 'var(--border)', background: 'var(--bg-surface)' }}
        >
          {onBack && (
            <button
              onClick={onBack}
              className="lg:hidden btn btn-ghost btn-sm px-2 py-1 shrink-0"
              aria-label="Voltar"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6" /></svg>
            </button>
          )}
          {detail?.conversation.contact && (
            <Avatar fallback={detail.conversation.contact.name ?? detail.conversation.contact.phoneNumber} size="md" />
          )}
          <div className="flex-1 min-w-0">
            <div className="text-[14px] font-semibold truncate" style={{ color: 'var(--text-1)' }}>
              {title}
            </div>
            {subtitle && (
              <div className="text-[11px] font-mono truncate" style={{ color: 'var(--text-3)' }}>
                {subtitle}
              </div>
            )}
          </div>
          {actions}
        </div>
        {children}
      </div>
    );
  };

  if (loading) {
    return (
      <Frame title="Conversa">
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
          Carregando...
        </div>
      </Frame>
    );
  }
  if (!detail) {
    return (
      <Frame title="Conversa nao encontrada">
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
          Conversa nao encontrada
        </div>
      </Frame>
    );
  }

  const { conversation } = detail;
  const isHumanMode = conversation.status === 'human';
  const isClosed = conversation.status === 'closed';

  return (
    <Frame
      title={conversation.contact?.name ?? conversation.contact?.phoneNumber ?? 'Conversa'}
      subtitle={conversation.contact?.phoneNumber}
      actions={
        <div className="flex items-center gap-3">
          {/* Toggle Dani ativa / pausada */}
          <button
            onClick={() => changeStatus(conversation.status === 'nina' ? 'human' : 'nina')}
            className="flex items-center gap-2 text-xs"
            title={conversation.status === 'nina' ? 'Pausar Dani' : 'Reativar Dani'}
          >
            <span
              className="toggle-track"
              style={{
                background:
                  conversation.status === 'nina'
                    ? 'var(--dani)'
                    : 'var(--border-strong)',
              }}
            >
              <span
                className="toggle-thumb"
                style={{ left: conversation.status === 'nina' ? 20 : 3 }}
              />
            </span>
            <span className="font-semibold" style={{ color: 'var(--text-2)' }}>
              {conversation.status === 'nina' ? (
                <>
                  <span style={{ color: 'var(--dani-text)' }}>✦ Dani</span> ativa
                </>
              ) : (
                'Dani pausada'
              )}
            </span>
          </button>
        </div>
      }
    >
      {/* Action bar */}
      <div className="border-b border-border bg-card/30 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-4xl mx-auto p-3 flex gap-2 justify-center flex-wrap">
          {/* Status changes */}
          {conversation.status !== 'human' && (
            <button onClick={() => changeStatus('human')} className="btn-primary btn-sm">
              Assumir conversa
            </button>
          )}
          {conversation.status === 'human' && (
            <button onClick={() => changeStatus('nina')} className="btn-secondary btn-sm">
              Devolver pra DANI
            </button>
          )}
          {conversation.status !== 'paused' && conversation.status !== 'closed' && (
            <button onClick={() => changeStatus('paused')} className="btn-secondary btn-sm">
              Pausar
            </button>
          )}
          {conversation.status !== 'closed' && (
            <button onClick={() => changeStatus('closed')} className="btn-danger btn-sm">
              Fechar
            </button>
          )}
          {conversation.status === 'closed' && (
            <button onClick={() => changeStatus('nina')} className="btn-secondary btn-sm">
              Reabrir
            </button>
          )}

          {/* Quick actions */}
          <div className="divider-v mx-1" />
          <button
            onClick={() => {
              setDealForm({
                ...dealForm,
                title: detail.conversation.contact?.name
                  ? `Deal - ${detail.conversation.contact.name}`
                  : 'Novo deal',
              });
              setShowDealModal(true);
            }}
            disabled={!conversation.contact}
            className="btn-secondary btn-sm"
          >
            + Deal
          </button>
          <button
            onClick={() => {
              setApptForm({
                ...apptForm,
                title: detail.conversation.contact?.name
                  ? `Consultoria - ${detail.conversation.contact.name}`
                  : 'Novo agendamento',
              });
              setShowApptModal(true);
            }}
            disabled={!conversation.contact}
            className="btn-secondary btn-sm"
          >
            + Agendar
          </button>
          <button
            onClick={handleAnalyze}
            disabled={analyzing || messages.length === 0}
            className="btn-sm rounded-md border border-primary/30 text-primary hover:bg-primary/10 disabled:opacity-40 transition-colors"
          >
            {analyzing ? 'Analisando...' : '✨ Analisar IA'}
          </button>
        </div>
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-y-auto p-4"
        style={{ background: 'var(--bg-app)' }}
      >
        <div className="max-w-3xl mx-auto flex flex-col gap-3">
          {/* Indicador de carregar mais (topo) */}
          {hasMore && (
            <div className="flex justify-center py-2">
              {loadingOlder ? (
                <span className="text-[11px] flex items-center gap-1.5" style={{ color: 'var(--text-3)' }}>
                  <svg width="12" height="12" className="animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" strokeOpacity="0.3" /><path d="M12 2a10 10 0 0 1 10 10" /></svg>
                  carregando mensagens antigas…
                </span>
              ) : (
                <button
                  onClick={loadOlder}
                  className="text-[11px] px-3 py-1 rounded-full transition-colors"
                  style={{ background: 'var(--bg-subtle)', color: 'var(--text-2)', border: '1px solid var(--border)' }}
                >
                  ↑ carregar mensagens anteriores
                </button>
              )}
            </div>
          )}

          {messages.length === 0 && (
            <div className="text-center text-sm py-16" style={{ color: 'var(--text-3)' }}>
              <p>Nenhuma mensagem ainda</p>
              <p className="text-xs mt-1 opacity-70">Aguardando primeira interação...</p>
            </div>
          )}
          {messages.map((m, idx) => {
            const isClient = m.fromType === 'user';
            const isDani = m.fromType === 'nina';
            const isHuman = m.fromType === 'human';
            const prevMsg = messages[idx - 1];
            const sameAuthor = prevMsg?.fromType === m.fromType;
            const contactName =
              conversation.contact?.name ?? conversation.contact?.phoneNumber ?? 'C';

            const time = new Date(m.createdAt).toLocaleString('pt-BR', {
              hour: '2-digit',
              minute: '2-digit',
            });

            return (
              <div
                key={m.id}
                className={`flex gap-2 ${isClient ? 'justify-start' : 'justify-end'} ${
                  sameAuthor ? '' : 'mt-2'
                } animate-fade-in`}
              >
                {/* Avatar cliente (esquerda) */}
                {isClient && (
                  <div className="shrink-0 w-7 flex items-end pb-1">
                    {!sameAuthor && <Avatar fallback={contactName} size="sm" />}
                  </div>
                )}

                <div className="flex flex-col">
                  {/* Label autor */}
                  {!sameAuthor && !isClient && (
                    <div
                      className={`bubble-author ${isDani ? 'dani' : 'human'} text-right pr-1`}
                    >
                      {isDani ? '✦ Dani' : '👤 Bia'}
                    </div>
                  )}
                  {/* Bolha */}
                  <div
                    className={`whitespace-pre-wrap ${
                      isClient ? 'bubble-client' : isDani ? 'bubble-nina' : 'bubble-human'
                    }`}
                  >
                    {m.content ?? <span className="opacity-60">[{m.messageType}]</span>}
                  </div>
                  {/* Timestamp */}
                  <div
                    className={`bubble-time ${isClient ? 'text-left pl-1' : 'text-right pr-1'}`}
                  >
                    {time}
                  </div>
                </div>

                {/* Avatar Dani/Bia (direita) */}
                {!isClient && (
                  <div className="shrink-0 w-7 flex items-end pb-1">
                    {!sameAuthor && (
                      isDani ? (
                        <DaniAvatar size="sm" active />
                      ) : (
                        <Avatar fallback={isHuman ? 'Bia' : '?'} size="sm" />
                      )
                    )}
                  </div>
                )}
              </div>
            );
          })}
          <div ref={endRef} />
        </div>
      </div>

      {/* Modal: Deal */}
      {showDealModal && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50"
          onClick={(e) => e.target === e.currentTarget && setShowDealModal(false)}
        >
          <div className="bg-card border border-border rounded-xl p-6 max-w-md w-full space-y-4">
            <h2 className="text-lg font-bold text-foreground">Novo deal</h2>
            <p className="text-xs text-muted-foreground">
              Contato: <b>{conversation.contact?.name ?? conversation.contact?.phoneNumber}</b>
            </p>
            <form onSubmit={handleCreateDeal} className="space-y-3">
              <div>
                <label className="block text-xs uppercase text-muted-foreground mb-1">Titulo *</label>
                <input
                  type="text"
                  value={dealForm.title}
                  onChange={(e) => setDealForm({ ...dealForm, title: e.target.value })}
                  required
                  className="w-full px-3 py-2 rounded-lg bg-background border border-border
                             text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <div>
                <label className="block text-xs uppercase text-muted-foreground mb-1">Valor R$</label>
                <input
                  type="number"
                  step="0.01"
                  value={dealForm.value}
                  onChange={(e) => setDealForm({ ...dealForm, value: e.target.value })}
                  placeholder="475.00"
                  className="w-full px-3 py-2 rounded-lg bg-background border border-border
                             text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <div>
                <label className="block text-xs uppercase text-muted-foreground mb-1">Notas</label>
                <textarea
                  value={dealForm.notes}
                  onChange={(e) => setDealForm({ ...dealForm, notes: e.target.value })}
                  rows={2}
                  className="w-full px-3 py-2 rounded-lg bg-background border border-border
                             text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <div className="flex gap-2 justify-end">
                <button
                  type="button"
                  onClick={() => setShowDealModal(false)}
                  className="px-4 py-2 rounded-lg border border-border text-sm text-muted-foreground"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={quickSaving || !dealForm.title}
                  className="px-4 py-2 rounded-lg gradient-pink text-white text-sm font-semibold
                             disabled:opacity-40"
                >
                  {quickSaving ? 'Criando...' : 'Criar deal'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Appointment */}
      {showApptModal && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50"
          onClick={(e) => e.target === e.currentTarget && setShowApptModal(false)}
        >
          <div className="bg-card border border-border rounded-xl p-6 max-w-md w-full space-y-4">
            <h2 className="text-lg font-bold text-foreground">Novo agendamento</h2>
            <p className="text-xs text-muted-foreground">
              Contato: <b>{conversation.contact?.name ?? conversation.contact?.phoneNumber}</b>
            </p>
            <form onSubmit={handleCreateAppt} className="space-y-3">
              <div>
                <label className="block text-xs uppercase text-muted-foreground mb-1">Titulo *</label>
                <input
                  type="text"
                  value={apptForm.title}
                  onChange={(e) => setApptForm({ ...apptForm, title: e.target.value })}
                  required
                  className="w-full px-3 py-2 rounded-lg bg-background border border-border
                             text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs uppercase text-muted-foreground mb-1">Data *</label>
                  <input
                    type="date"
                    value={apptForm.date}
                    onChange={(e) => setApptForm({ ...apptForm, date: e.target.value })}
                    required
                    className="w-full px-3 py-2 rounded-lg bg-background border border-border
                               text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
                <div>
                  <label className="block text-xs uppercase text-muted-foreground mb-1">Hora</label>
                  <input
                    type="time"
                    value={apptForm.time}
                    onChange={(e) => setApptForm({ ...apptForm, time: e.target.value })}
                    className="w-full px-3 py-2 rounded-lg bg-background border border-border
                               text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
                <div>
                  <label className="block text-xs uppercase text-muted-foreground mb-1">Duracao</label>
                  <input
                    type="number"
                    value={apptForm.duration}
                    onChange={(e) =>
                      setApptForm({ ...apptForm, duration: Number(e.target.value) || 60 })
                    }
                    min={15}
                    step={15}
                    className="w-full px-3 py-2 rounded-lg bg-background border border-border
                               text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs uppercase text-muted-foreground mb-1">Tipo</label>
                <select
                  value={apptForm.type}
                  onChange={(e) => setApptForm({ ...apptForm, type: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg bg-background border border-border
                             text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="consultation">Consulta</option>
                  <option value="smart_baby">Smart Baby</option>
                  <option value="estilosa">Estilosa</option>
                  <option value="vip">VIP</option>
                  <option value="concierge">Concierge</option>
                  <option value="premium">Premium</option>
                  <option value="visita_loja">Visita loja</option>
                </select>
              </div>
              <div className="flex gap-2 justify-end">
                <button
                  type="button"
                  onClick={() => setShowApptModal(false)}
                  className="px-4 py-2 rounded-lg border border-border text-sm text-muted-foreground"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={quickSaving || !apptForm.title || !apptForm.date}
                  className="px-4 py-2 rounded-lg gradient-pink text-white text-sm font-semibold
                             disabled:opacity-40"
                >
                  {quickSaving ? 'Criando...' : 'Agendar'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Analysis */}
      {showAnalysis && analysis && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50 overflow-y-auto"
          onClick={(e) => e.target === e.currentTarget && setShowAnalysis(false)}
        >
          <div className="bg-card border border-border rounded-xl p-6 max-w-lg w-full space-y-4 my-8">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-foreground">🤖 Analise IA</h2>
              <button
                onClick={() => setShowAnalysis(false)}
                className="text-muted-foreground hover:text-foreground text-xl"
              >
                ✕
              </button>
            </div>

            {/* Badges */}
            <div className="flex gap-2 flex-wrap">
              <span
                className={`px-2 py-1 rounded text-xs font-semibold ${
                  analysis.qualification === 'quente'
                    ? 'bg-fce-red/20 text-fce-red'
                    : analysis.qualification === 'morno'
                    ? 'bg-yellow-500/20 text-yellow-400'
                    : 'bg-muted text-muted-foreground'
                }`}
              >
                Lead {analysis.qualification}
              </span>
              <span
                className={`px-2 py-1 rounded text-xs font-semibold ${
                  analysis.sentiment === 'positivo'
                    ? 'bg-fce-green/20 text-fce-green'
                    : analysis.sentiment === 'negativo'
                    ? 'bg-fce-red/20 text-fce-red'
                    : 'bg-muted text-muted-foreground'
                }`}
              >
                {analysis.sentiment}
              </span>
              {analysis.flags.needs_human && (
                <span className="px-2 py-1 rounded text-xs font-semibold bg-fce-red/20 text-fce-red">
                  ⚠ precisa humano
                </span>
              )}
              {analysis.flags.needs_appointment && (
                <span className="px-2 py-1 rounded text-xs font-semibold bg-fce-pink/20 text-fce-pink">
                  📅 quer agendar
                </span>
              )}
              {analysis.flags.customer_unhappy && (
                <span className="px-2 py-1 rounded text-xs font-semibold bg-fce-red/20 text-fce-red">
                  😠 cliente bravo
                </span>
              )}
            </div>

            <div>
              <h3 className="text-xs uppercase text-muted-foreground mb-1">Resumo</h3>
              <p className="text-sm text-foreground">{analysis.summary}</p>
            </div>

            <div>
              <h3 className="text-xs uppercase text-muted-foreground mb-1">Intent</h3>
              <p className="text-sm text-foreground">{analysis.intent}</p>
            </div>

            {analysis.topics.length > 0 && (
              <div>
                <h3 className="text-xs uppercase text-muted-foreground mb-1">Topicos</h3>
                <div className="flex gap-1 flex-wrap">
                  {analysis.topics.map((t) => (
                    <span
                      key={t}
                      className="px-2 py-0.5 rounded bg-card border border-border text-xs"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {analysis.next_steps.length > 0 && (
              <div>
                <h3 className="text-xs uppercase text-muted-foreground mb-1">Proximos passos</h3>
                <ol className="text-sm text-foreground space-y-1 list-decimal list-inside">
                  {analysis.next_steps.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ol>
              </div>
            )}

            <div className="flex gap-2 justify-end pt-2">
              {analysis.flags.needs_appointment && (
                <button
                  onClick={() => {
                    setShowAnalysis(false);
                    setApptForm({
                      ...apptForm,
                      title: `Consultoria - ${conversation.contact?.name ?? 'Cliente'}`,
                    });
                    setShowApptModal(true);
                  }}
                  className="px-3 py-1.5 rounded-lg gradient-pink text-white text-xs font-semibold"
                >
                  + Agendar
                </button>
              )}
              {analysis.qualification === 'quente' && (
                <button
                  onClick={() => {
                    setShowAnalysis(false);
                    setDealForm({
                      ...dealForm,
                      title: `Deal - ${conversation.contact?.name ?? 'Cliente'}`,
                    });
                    setShowDealModal(true);
                  }}
                  className="px-3 py-1.5 rounded-lg border border-fce-pink/40 text-fce-pink text-xs"
                >
                  + Criar deal
                </button>
              )}
              <button
                onClick={() => setShowAnalysis(false)}
                className="px-3 py-1.5 rounded-lg border border-border text-xs text-muted-foreground"
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Input footer sticky */}
      <div className="border-t border-border bg-card/40 backdrop-blur-sm p-3 sticky bottom-0">
        <div className="max-w-3xl mx-auto space-y-2">
          {!isHumanMode && !isClosed && (
            <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
              <span className="badge-dot bg-primary animate-pulse-dot" />
              DANI está no comando. Clique <span className="text-foreground font-medium">Assumir conversa</span> pra responder manualmente.
            </div>
          )}
          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
              {error}
            </div>
          )}
          <form onSubmit={handleSend} className="flex flex-col gap-2">
            {/* Barra de ferramentas (emoji + anexar) */}
            {isHumanMode && !isClosed && (
              <div className="flex items-center gap-1 px-1">
                {/* Emoji picker básico (grade de emojis comuns) */}
                <EmojiPicker onPick={(e) => setInput((v) => v + e)} />
                {/* Anexar imagem */}
                <label
                  className="btn btn-ghost btn-sm px-2 py-1 cursor-pointer"
                  title="Enviar imagem"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                    <circle cx="8.5" cy="8.5" r="1.5" />
                    <polyline points="21 15 16 10 5 21" />
                  </svg>
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file || !accountId || !conversationId) return;
                      setSending(true);
                      try {
                        const fd = new FormData();
                        fd.append('file', file);
                        fd.append('conversationId', conversationId);
                        fd.append('accountId', accountId);
                        await api.postForm(`/crm/conversations/${conversationId}/upload?accountId=${accountId}`, fd);
                        await loadDetail();
                      } catch (err) {
                        setError(err instanceof ApiError ? err.message : 'Falha ao enviar imagem');
                      } finally {
                        setSending(false);
                        e.target.value = '';
                      }
                    }}
                  />
                </label>
              </div>
            )}

            <div className="flex gap-2 items-end">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    if (!isHumanMode || isClosed || sending || !input.trim()) return;
                    handleSend(e as unknown as React.FormEvent);
                  }
                }}
                disabled={!isHumanMode || isClosed || sending}
                placeholder={
                  isClosed
                    ? 'Conversa fechada'
                    : isHumanMode
                      ? 'Responder como Bia… (Enter envia, Shift+Enter quebra linha)'
                      : 'Sugerir resposta à Dani…'
                }
                rows={1}
                className="input-base input-lg flex-1 resize-none"
                style={{ minHeight: 44, maxHeight: 120, overflowY: 'auto' }}
              />
              <button
                type="submit"
                disabled={!isHumanMode || isClosed || sending || !input.trim()}
                className="btn btn-primary btn-lg shrink-0"
                style={{ width: 46, height: 44, padding: 0, justifyContent: 'center' }}
                aria-label="Enviar"
              >
                {sending ? (
                  <svg width="16" height="16" className="animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" strokeOpacity="0.3"/><path d="M12 2a10 10 0 0 1 10 10" /></svg>
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="22" y1="2" x2="11" y2="13" />
                    <polygon points="22 2 15 22 11 13 2 9 22 2" />
                  </svg>
                )}
              </button>
            </div>
          </form>
        </div>
      </div>
    </Frame>
  );
}

// ── Emoji picker simples ─────────────────────────────
const COMMON_EMOJIS = [
  '😀','😂','😊','😍','🥰','😘','😎','🤩','😅','😂',
  '🙏','👍','👏','❤️','🔥','✨','🎉','💯','🤝','👋',
  '😢','😱','🤔','💪','🙌','👌','💕','🌟','🎊','🥳',
  '📦','📸','📋','📞','💬','📱','🛒','💰','✅','⚡',
];

function EmojiPicker({ onPick }: { onPick: (e: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (ref.current && !ref.current.contains(e.target as Node)) {
      setOpen(false);
    }
  }, []);

  useEffect(() => {
    if (open) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open, handleClickOutside]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="btn btn-ghost btn-sm px-2 py-1"
        title="Emoji"
      >
        <span style={{ fontSize: 18, lineHeight: 1 }}>😊</span>
      </button>
      {open && (
        <div
          className="absolute bottom-full left-0 mb-2 rounded-xl p-2 z-50"
          style={{
            background: 'var(--bg-surface)',
            border: '1px solid var(--border)',
            boxShadow: 'var(--sh-lg)',
            width: 240,
          }}
        >
          <div className="grid grid-cols-8 gap-0.5">
            {COMMON_EMOJIS.map((em) => (
              <button
                key={em}
                type="button"
                onClick={() => { onPick(em); setOpen(false); }}
                className="text-[18px] p-1 rounded hover:bg-muted transition-colors leading-none"
              >
                {em}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
