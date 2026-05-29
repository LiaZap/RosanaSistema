import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';

interface MeResponse {
  user: { id: string; email: string };
  accounts: Array<{ accountId: string; role: string; accountName: string }>;
}

interface ConversationRow {
  id: string;
  status: 'nina' | 'human' | 'paused' | 'closed';
  lastMessageAt: string | null;
  createdAt: string;
  contactId: string;
  contactName: string | null;
  contactPhone: string;
  lastMessage: string | null;
  lastMessageFrom: 'user' | 'nina' | 'human' | null;
}

interface Stats {
  nina: number;
  human: number;
  paused: number;
  closed: number;
  total: number;
}

const STATUS_LABELS: Record<ConversationRow['status'], string> = {
  nina: 'DANI',
  human: 'Humano',
  paused: 'Pausado',
  closed: 'Fechado',
};

const STATUS_COLORS: Record<ConversationRow['status'], string> = {
  nina: 'bg-fce-pink/20 text-fce-pink border-fce-pink/40',
  human: 'bg-fce-green/20 text-fce-green border-fce-green/40',
  paused: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/40',
  closed: 'bg-muted text-muted-foreground border-border',
};

function timeAgo(date: string | null): string {
  if (!date) return '—';
  const ms = Date.now() - new Date(date).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

export default function ConversationsPage() {
  const navigate = useNavigate();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [accountId, setAccountId] = useState<string>('');
  const [filter, setFilter] = useState<'all' | 'nina' | 'human' | 'paused' | 'closed'>('all');
  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');

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

  async function loadList() {
    if (!accountId) return;
    setLoading(true);
    try {
      const q = filter === 'all' ? '' : `&status=${filter}`;
      const data = await api.get<{ conversations: ConversationRow[] }>(
        `/crm/conversations?accountId=${accountId}${q}`,
      );
      setConversations(data.conversations);
      const s = await api.get<Stats>(`/crm/stats?accountId=${accountId}`);
      setStats(s);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, filter]);

  // Auto-refresh a cada 15s
  useEffect(() => {
    if (!accountId) return;
    const interval = setInterval(() => loadList(), 15000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, filter]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return conversations;
    return conversations.filter((c) => {
      return (
        (c.contactName ?? '').toLowerCase().includes(term) ||
        c.contactPhone.includes(term) ||
        (c.lastMessage ?? '').toLowerCase().includes(term)
      );
    });
  }, [conversations, search]);

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl gradient-pink flex items-center justify-center">
              <span className="text-white font-bold text-lg">C</span>
            </div>
            <div>
              <h1 className="text-xl font-bold text-foreground">Conversas</h1>
              <p className="text-sm text-muted-foreground">
                {me?.accounts[0]?.accountName ?? 'Conta'}
              </p>
            </div>
          </div>
          <Link
            to="/dashboard"
            className="px-3 py-2 rounded-lg border border-border text-sm
                       text-muted-foreground hover:bg-card transition-colors"
          >
            Voltar
          </Link>
        </div>

        {/* Stats */}
        {stats && (
          <div className="grid grid-cols-5 gap-3">
            <button
              onClick={() => setFilter('all')}
              className={`glass rounded-xl p-3 text-left transition-colors ${
                filter === 'all' ? 'ring-2 ring-fce-pink' : ''
              }`}
            >
              <div className="text-xs uppercase text-muted-foreground">Total</div>
              <div className="text-2xl font-bold text-foreground">{stats.total}</div>
            </button>
            <button
              onClick={() => setFilter('nina')}
              className={`glass rounded-xl p-3 text-left transition-colors ${
                filter === 'nina' ? 'ring-2 ring-fce-pink' : ''
              }`}
            >
              <div className="text-xs uppercase text-muted-foreground">DANI</div>
              <div className="text-2xl font-bold text-fce-pink">{stats.nina}</div>
            </button>
            <button
              onClick={() => setFilter('human')}
              className={`glass rounded-xl p-3 text-left transition-colors ${
                filter === 'human' ? 'ring-2 ring-fce-pink' : ''
              }`}
            >
              <div className="text-xs uppercase text-muted-foreground">Humano</div>
              <div className="text-2xl font-bold text-fce-green">{stats.human}</div>
            </button>
            <button
              onClick={() => setFilter('paused')}
              className={`glass rounded-xl p-3 text-left transition-colors ${
                filter === 'paused' ? 'ring-2 ring-fce-pink' : ''
              }`}
            >
              <div className="text-xs uppercase text-muted-foreground">Pausado</div>
              <div className="text-2xl font-bold text-yellow-400">{stats.paused}</div>
            </button>
            <button
              onClick={() => setFilter('closed')}
              className={`glass rounded-xl p-3 text-left transition-colors ${
                filter === 'closed' ? 'ring-2 ring-fce-pink' : ''
              }`}
            >
              <div className="text-xs uppercase text-muted-foreground">Fechado</div>
              <div className="text-2xl font-bold text-muted-foreground">{stats.closed}</div>
            </button>
          </div>
        )}

        {/* Search */}
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por nome, telefone ou conteudo..."
          className="w-full px-4 py-3 rounded-lg bg-card border border-border
                     text-foreground placeholder:text-muted-foreground text-sm
                     focus:outline-none focus:ring-2 focus:ring-ring"
        />

        {/* List */}
        <div className="space-y-2">
          {loading && conversations.length === 0 && (
            <p className="text-center text-muted-foreground text-sm py-12">Carregando...</p>
          )}
          {!loading && filtered.length === 0 && (
            <p className="text-center text-muted-foreground text-sm py-12">
              Nenhuma conversa {filter !== 'all' ? `com status "${STATUS_LABELS[filter as keyof typeof STATUS_LABELS]}"` : 'ainda'}
            </p>
          )}
          {filtered.map((conv) => (
            <Link
              key={conv.id}
              to={`/conversations/${conv.id}`}
              className="glass rounded-xl p-4 flex gap-3 hover:bg-card/50 transition-colors"
            >
              {/* Avatar */}
              <div className="w-12 h-12 rounded-full bg-card border border-border
                              flex items-center justify-center text-lg font-bold text-foreground shrink-0">
                {(conv.contactName?.[0] ?? conv.contactPhone[0] ?? '?').toUpperCase()}
              </div>

              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-foreground truncate">
                    {conv.contactName ?? conv.contactPhone}
                  </span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded border ${STATUS_COLORS[conv.status]}`}>
                    {STATUS_LABELS[conv.status]}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground truncate mt-0.5">
                  {conv.lastMessageFrom === 'nina' || conv.lastMessageFrom === 'human' ? '↗ ' : ''}
                  {conv.lastMessage ?? '(sem mensagens)'}
                </p>
              </div>

              {/* Time */}
              <div className="text-xs text-muted-foreground shrink-0 self-start">
                {timeAgo(conv.lastMessageAt ?? conv.createdAt)}
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
