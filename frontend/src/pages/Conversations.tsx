import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import AppShell from '../components/AppShell';
import { Avatar } from '../components/ui/avatar';

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

interface Stats {
  nina: number;
  human: number;
  paused: number;
  closed: number;
  total: number;
}

const FILTERS: Array<{
  key: 'all' | 'nina' | 'human' | 'paused' | 'closed';
  label: string;
  dot: string | null;
}> = [
  { key: 'all', label: 'Todas', dot: null },
  { key: 'nina', label: 'Dani', dot: 'var(--dani)' },
  { key: 'human', label: 'Humano', dot: 'var(--success)' },
  { key: 'paused', label: 'Pausadas', dot: 'var(--warning)' },
  { key: 'closed', label: 'Fechadas', dot: 'var(--text-3)' },
];

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

function leadHeat(score: number): { label: string; color: string } | null {
  if (score >= 70) return { label: 'quente', color: 'var(--danger)' };
  if (score >= 30) return { label: 'morno', color: 'var(--warning)' };
  if (score > 0) return { label: 'frio', color: 'var(--info)' };
  return null;
}

const PERIOD_OPTIONS = [
  { value: '7',   label: '7 dias' },
  { value: '30',  label: '30 dias' },
  { value: '90',  label: '90 dias' },
  { value: 'all', label: 'Todas' },
];

export default function ConversationsPage() {
  const navigate = useNavigate();
  const [, setMe] = useState<MeResponse | null>(null);
  const [accountId, setAccountId] = useState<string>('');
  const [filter, setFilter] = useState<'all' | 'nina' | 'human' | 'paused' | 'closed'>('all');
  const [period, setPeriod] = useState<string>('30');
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
      const statusQ = filter === 'all' ? '' : `&status=${filter}`;
      const daysQ = `&days=${period}`;
      const data = await api.get<{ conversations: ConversationRow[] }>(
        `/crm/conversations?accountId=${accountId}${statusQ}${daysQ}`,
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
  }, [accountId, filter, period]);

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

  const countFor = (k: typeof FILTERS[number]['key']) => {
    if (!stats) return 0;
    return k === 'all' ? stats.total : stats[k];
  };

  return (
    <AppShell
      title="Conversas"
      subtitle={`${conversations.length} conversa${conversations.length === 1 ? '' : 's'} · atualiza a cada 15s`}
      bare
    >
      {/* Toolbar — filtros chip + search */}
      <div
        className="border-b sticky top-0 z-10"
        style={{ borderColor: 'var(--border)', background: 'var(--bg-app)' }}
      >
        <div className="px-5 py-3 flex flex-wrap items-center gap-3">
          {/* Filtros chip */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {FILTERS.map((f) => {
              const active = filter === f.key;
              return (
                <button
                  key={f.key}
                  onClick={() => setFilter(f.key)}
                  className="text-[12.5px] font-medium px-3 py-1.5 rounded-full transition-all flex items-center gap-1.5"
                  style={{
                    background: active ? 'var(--primary-tint)' : 'transparent',
                    color: active ? 'var(--primary-text)' : 'var(--text-2)',
                    border: `1px solid ${active ? 'var(--primary)' : 'var(--border)'}`,
                  }}
                >
                  {f.dot && (
                    <span
                      className="w-1.5 h-1.5 rounded-full"
                      style={{ background: f.dot }}
                    />
                  )}
                  <span>{f.label}</span>
                  <span
                    className="ml-0.5 text-[10.5px] font-semibold tabular-nums"
                    style={{ color: active ? 'var(--primary-text)' : 'var(--text-3)' }}
                  >
                    {countFor(f.key)}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Período */}
          <div className="flex items-center gap-1 ml-2">
            {PERIOD_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setPeriod(opt.value)}
                className="text-[12px] font-medium px-2.5 py-1.5 rounded-full transition-all"
                style={{
                  background: period === opt.value ? 'var(--bg-subtle)' : 'transparent',
                  color: period === opt.value ? 'var(--text-1)' : 'var(--text-3)',
                  border: `1px solid ${period === opt.value ? 'var(--border-strong)' : 'transparent'}`,
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Search */}
          <div className="flex-1 min-w-[200px] max-w-md ml-auto relative">
            <svg
              className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              style={{ color: 'var(--text-3)' }}
            >
              <circle cx="11" cy="11" r="7" strokeWidth="2" />
              <path d="m21 21-4.3-4.3" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por nome, telefone ou mensagem…"
              className="input-base"
              style={{ paddingLeft: 36, height: 36, fontSize: 13 }}
            />
          </div>
        </div>
      </div>

      {/* Lista */}
      <div className="px-5 py-4">
        {loading && conversations.length === 0 && (
          <div className="space-y-2">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="skeleton h-16 rounded-xl" />
            ))}
          </div>
        )}

        {!loading && filtered.length === 0 && (
          <div className="text-center py-20" style={{ color: 'var(--text-3)' }}>
            <div className="text-sm mb-1">Nenhuma conversa por aqui.</div>
            <div className="text-xs">
              {filter !== 'all'
                ? `Tente outro filtro ou aguarde clientes em "${
                    FILTERS.find((f) => f.key === filter)?.label
                  }".`
                : 'Quando alguem chamar no WhatsApp, vai aparecer aqui.'}
            </div>
          </div>
        )}

        <div className="space-y-1.5">
          {filtered.map((conv) => {
            const heat = leadHeat(conv.leadScore);
            const isDani = conv.status === 'nina';
            const isHuman = conv.status === 'human';
            const lastFromAgent = conv.lastMessageFrom === 'nina' || conv.lastMessageFrom === 'human';

            return (
              <Link
                key={conv.id}
                to={`/conversations/${conv.id}`}
                className="material lift block px-4 py-3 group"
                style={{ textDecoration: 'none' }}
              >
                <div className="flex items-start gap-3">
                  {/* Avatar com status dot */}
                  <div className="relative shrink-0">
                    <Avatar
                      fallback={conv.contactName ?? `+${conv.contactPhone}`}
                      size="md"
                    />
                    {/* Status dot */}
                    <span
                      className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2"
                      style={{
                        background: isDani
                          ? 'var(--dani)'
                          : isHuman
                          ? 'var(--success)'
                          : conv.status === 'paused'
                          ? 'var(--warning)'
                          : 'var(--text-3)',
                        borderColor: 'var(--bg-surface)',
                      }}
                      title={
                        isDani
                          ? 'Dani ativa'
                          : isHuman
                          ? 'Humano respondendo'
                          : conv.status === 'paused'
                          ? 'Pausada'
                          : 'Fechada'
                      }
                    />
                  </div>

                  {/* Conteudo */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span
                        className="text-[14px] font-semibold truncate"
                        style={{ color: 'var(--text-1)' }}
                      >
                        {conv.contactName ?? `+${conv.contactPhone}`}
                      </span>

                      {isDani && (
                        <span
                          className="inline-flex items-center gap-0.5 text-[10.5px] font-semibold shrink-0 px-1.5 py-0.5 rounded-full"
                          style={{
                            background: 'var(--dani-bg)',
                            color: 'var(--dani-text)',
                          }}
                        >
                          ✦ Dani
                        </span>
                      )}

                      {heat && (
                        <span
                          className="text-[10.5px] font-semibold px-1.5 py-0.5 rounded-full shrink-0"
                          style={{
                            background: 'transparent',
                            color: heat.color,
                            border: `1px solid ${heat.color}`,
                          }}
                        >
                          {heat.label}
                        </span>
                      )}

                      {conv.intentLabel && conv.intentLabel !== 'curioso' && (
                        <span
                          className="text-[10.5px] font-medium px-1.5 py-0.5 rounded-full shrink-0"
                          style={{
                            background: 'var(--bg-subtle)',
                            color: 'var(--text-2)',
                          }}
                        >
                          {INTENT_LABELS[conv.intentLabel] ?? conv.intentLabel}
                        </span>
                      )}

                      {conv.followupState === 'sent' && (
                        <span
                          className="text-[10.5px] font-medium px-1.5 py-0.5 rounded-full shrink-0 inline-flex items-center gap-1"
                          style={{
                            background: 'var(--dani-bg)',
                            color: 'var(--dani-text)',
                          }}
                        >
                          ↻ follow-up
                        </span>
                      )}
                    </div>

                    <p
                      className="text-[12.5px] truncate"
                      style={{ color: 'var(--text-2)' }}
                    >
                      {lastFromAgent && (
                        <span style={{ color: 'var(--text-3)' }}>
                          {conv.lastMessageFrom === 'nina' ? '✦ ' : '↳ '}
                        </span>
                      )}
                      {conv.lastMessage ?? <span style={{ color: 'var(--text-3)' }}>(sem mensagens)</span>}
                    </p>
                  </div>

                  {/* Timestamp + phone */}
                  <div className="text-right shrink-0 flex flex-col items-end gap-0.5">
                    <span
                      className="text-[11px] tabular-nums"
                      style={{ color: 'var(--text-3)' }}
                    >
                      {timeAgo(conv.lastMessageAt ?? conv.createdAt)}
                    </span>
                    {!conv.contactName && (
                      <span
                        className="text-[10.5px] tabular-nums font-mono"
                        style={{ color: 'var(--text-3)' }}
                      >
                        +{conv.contactPhone.slice(-4)}
                      </span>
                    )}
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      </div>
    </AppShell>
  );
}
