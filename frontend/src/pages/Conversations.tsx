import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import AppShell from '../components/AppShell';

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
  intentLabel: string | null;
  sentiment: 'positivo' | 'neutro' | 'negativo' | null;
  leadScore: number;
  followupState: string | null;
}

const INTENT_LABELS: Record<string, string> = {
  curioso: 'curioso',
  comprador: 'comprador',
  aluguel: 'aluguel',
  consultoria: 'consultoria',
  reclamacao: 'reclamação',
  suporte: 'suporte',
  comprovante: 'comprovante',
  despedida: 'despedida',
};

function leadBadge(score: number): { label: string; cls: string } | null {
  if (score >= 70) return { label: '🔥 quente', cls: 'bg-fce-red/15 text-fce-red border-fce-red/30' };
  if (score >= 30) return { label: '🌡 morno', cls: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30' };
  if (score > 0) return { label: '❄ frio', cls: 'bg-blue-500/10 text-blue-400 border-blue-500/30' };
  return null;
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
  nina: 'bg-primary/10 text-primary border-primary/20',
  human: 'bg-fce-green/10 text-fce-green border-fce-green/20',
  paused: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
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
  const [, setMe] = useState<MeResponse | null>(null);
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
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, filter]);

  useEffect(() => {
    if (!accountId) return;
    const interval = setInterval(() => loadList(), 15000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, filter]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return conversations;
    return conversations.filter(
      (c) =>
        (c.contactName ?? '').toLowerCase().includes(term) ||
        c.contactPhone.includes(term) ||
        (c.lastMessage ?? '').toLowerCase().includes(term),
    );
  }, [conversations, search]);

  return (
    <AppShell
      title="Conversas"
      subtitle={`${conversations.length} conversas · auto-refresh 15s`}
    >
      <div className="space-y-5">
        {/* Stats */}
        {stats && (
          <div className="grid grid-cols-5 gap-2">
            {(['all', 'nina', 'human', 'paused', 'closed'] as const).map((key) => {
              const count = key === 'all' ? stats.total : stats[key];
              const labels: Record<typeof key, string> = {
                all: 'Total',
                nina: 'DANI',
                human: 'Humano',
                paused: 'Pausado',
                closed: 'Fechado',
              };
              const colors: Record<typeof key, string> = {
                all: 'text-foreground',
                nina: 'text-primary',
                human: 'text-fce-green',
                paused: 'text-yellow-400',
                closed: 'text-muted-foreground',
              };
              return (
                <button
                  key={key}
                  onClick={() => setFilter(key)}
                  className={`card-base p-3 text-left transition-colors ${
                    filter === key
                      ? 'border-primary/50 bg-primary/5'
                      : 'hover:border-border'
                  }`}
                >
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    {labels[key]}
                  </div>
                  <div className={`text-xl font-semibold mt-0.5 ${colors[key]}`}>{count}</div>
                </button>
              );
            })}
          </div>
        )}

        {/* Search */}
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por nome, telefone ou conteudo..."
          className="input-base"
        />

        {/* List */}
        <div className="space-y-1.5">
          {loading && conversations.length === 0 && (
            <p className="text-center text-muted-foreground text-sm py-12">Carregando...</p>
          )}
          {!loading && filtered.length === 0 && (
            <p className="text-center text-muted-foreground text-sm py-12">
              Nenhuma conversa
              {filter !== 'all' ? ` com status "${STATUS_LABELS[filter as keyof typeof STATUS_LABELS]}"` : ''}
            </p>
          )}
          {filtered.map((conv) => (
            <Link
              key={conv.id}
              to={`/conversations/${conv.id}`}
              className="card-base hover:border-border hover:bg-muted/30
                         p-3 flex gap-3 transition-colors"
            >
              <div
                className="w-10 h-10 rounded-full bg-secondary border border-border
                           flex items-center justify-center text-sm font-semibold text-foreground shrink-0"
              >
                {(conv.contactName?.[0] ?? conv.contactPhone[0] ?? '?').toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-foreground truncate text-sm">
                    {conv.contactName ?? conv.contactPhone}
                  </span>
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded border ${STATUS_COLORS[conv.status]}`}
                  >
                    {STATUS_LABELS[conv.status]}
                  </span>
                  {(() => {
                    const lb = leadBadge(conv.leadScore);
                    return lb ? (
                      <span className={`text-[10px] px-1.5 py-0.5 rounded border ${lb.cls}`}>
                        {lb.label}
                      </span>
                    ) : null;
                  })()}
                  {conv.intentLabel && conv.intentLabel !== 'curioso' && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded border border-border bg-card text-muted-foreground">
                      {INTENT_LABELS[conv.intentLabel] ?? conv.intentLabel}
                    </span>
                  )}
                  {conv.followupState === 'sent' && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded border bg-fce-pink/10 text-fce-pink border-fce-pink/30">
                      ↻ follow-up
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground truncate mt-0.5">
                  {conv.lastMessageFrom === 'nina' || conv.lastMessageFrom === 'human' ? '↗ ' : ''}
                  {conv.lastMessage ?? '(sem mensagens)'}
                </p>
              </div>
              <div className="text-xs text-muted-foreground shrink-0 self-start mt-1">
                {timeAgo(conv.lastMessageAt ?? conv.createdAt)}
              </div>
            </Link>
          ))}
        </div>
      </div>
    </AppShell>
  );
}
