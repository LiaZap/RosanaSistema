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
          {/* Status changes */}
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

          {/* Quick actions */}
          <div className="w-px h-6 bg-border self-center mx-1" />
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
            className="px-3 py-1.5 rounded-lg border border-border text-xs text-foreground hover:bg-card
                       disabled:opacity-40"
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
            className="px-3 py-1.5 rounded-lg border border-border text-xs text-foreground hover:bg-card
                       disabled:opacity-40"
          >
            + Agendar
          </button>
          <button
            onClick={handleAnalyze}
            disabled={analyzing || messages.length === 0}
            className="px-3 py-1.5 rounded-lg border border-fce-pink/40 text-fce-pink text-xs hover:bg-fce-pink/10
                       disabled:opacity-40"
          >
            {analyzing ? 'Analisando...' : '🤖 Analisar'}
          </button>
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
