import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import AppShell from '../components/AppShell';
import { Avatar } from '../components/ui/avatar';
import ConversationDetailPage from './ConversationDetail';

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

// Cards de estatística no topo da lista (estilo FCE Studio)
const STAT_CARDS: Array<{
  key: 'all' | 'nina' | 'human' | 'closed';
  label: string;
  color: string;
}> = [
  { key: 'all', label: 'TOTAL', color: 'var(--text-1)' },
  { key: 'nina', label: 'DANI', color: 'var(--dani)' },
  { key: 'human', label: 'HUMANO', color: 'var(--success)' },
  { key: 'closed', label: 'FECHADO', color: 'var(--text-3)' },
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
  const [selectedId, setSelectedId] = useState<string | null>(null);

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

  const countFor = (k: 'all' | 'nina' | 'human' | 'paused' | 'closed') => {
    if (!stats) return 0;
    return k === 'all' ? stats.total : stats[k];
  };

  return (
    <AppShell title="Conversas" subtitle={`${conversations.length} conversas · atualiza a cada 15s`} bare>
      <div className="flex flex-1 min-h-0">
        {/* ─── LEFT: lista ─────────────────────────── */}
        <div
          className={`w-full lg:w-[400px] shrink-0 flex-col min-h-0 border-r ${selectedId ? 'hidden lg:flex' : 'flex'}`}
          style={{ borderColor: 'var(--border)' }}
        >
          {/* Stats cards */}
          <div className="grid grid-cols-4 gap-1.5 px-3 pt-3 pb-2">
            {STAT_CARDS.map((s) => {
              const active = filter === s.key;
              return (
                <button
                  key={s.key}
                  onClick={() => setFilter(s.key)}
                  className="rounded-lg px-2 py-2 text-left transition-all"
                  style={{
                    background: active ? 'var(--primary-tint)' : 'var(--bg-surface)',
                    border: `1px solid ${active ? 'var(--primary)' : 'var(--border)'}`,
                  }}
                >
                  <div className="text-[18px] font-bold tabular-nums leading-none" style={{ color: s.color }}>
                    {countFor(s.key)}
                  </div>
                  <div className="text-[9px] font-semibold uppercase tracking-wider mt-1" style={{ color: 'var(--text-3)' }}>
                    {s.label}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Toolbar: filtros + período + busca */}
          <div className="px-3 pb-2 space-y-2 border-b" style={{ borderColor: 'var(--border)' }}>
            <div className="flex items-center gap-1 flex-wrap">
              {FILTERS.map((f) => {
                const active = filter === f.key;
                return (
                  <button
                    key={f.key}
                    onClick={() => setFilter(f.key)}
                    className="text-[11.5px] font-medium px-2.5 py-1 rounded-full transition-all flex items-center gap-1"
                    style={{
                      background: active ? 'var(--primary-tint)' : 'transparent',
                      color: active ? 'var(--primary-text)' : 'var(--text-2)',
                      border: `1px solid ${active ? 'var(--primary)' : 'var(--border)'}`,
                    }}
                  >
                    {f.dot && <span className="w-1.5 h-1.5 rounded-full" style={{ background: f.dot }} />}
                    {f.label}
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <svg
                  className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 pointer-events-none"
                  fill="none" stroke="currentColor" viewBox="0 0 24 24" style={{ color: 'var(--text-3)' }}
                >
                  <circle cx="11" cy="11" r="7" strokeWidth="2" />
                  <path d="m21 21-4.3-4.3" strokeWidth="2" strokeLinecap="round" />
                </svg>
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Buscar nome, telefone…"
                  className="input-base"
                  style={{ paddingLeft: 32, height: 32, fontSize: 12.5 }}
                />
              </div>
              <select
                value={period}
                onChange={(e) => setPeriod(e.target.value)}
                className="input-base shrink-0"
                style={{ height: 32, fontSize: 12, width: 90, padding: '0 8px' }}
              >
                {PERIOD_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Lista scrollável */}
          <div className="flex-1 overflow-y-auto px-2 py-2 space-y-1 min-h-0">
            {loading && conversations.length === 0 && (
              <div className="space-y-1.5">
                {[1, 2, 3, 4, 5, 6].map((i) => <div key={i} className="skeleton h-16 rounded-xl" />)}
              </div>
            )}

            {!loading && filtered.length === 0 && (
              <div className="text-center py-16 px-4" style={{ color: 'var(--text-3)' }}>
                <div className="text-sm mb-1">Nenhuma conversa.</div>
                <div className="text-xs">
                  {filter !== 'all'
                    ? `Tente outro filtro.`
                    : 'Quando alguém chamar no WhatsApp, aparece aqui.'}
                </div>
              </div>
            )}

            {filtered.map((conv) => {
              const heat = leadHeat(conv.leadScore);
              const isDani = conv.status === 'nina';
              const isHuman = conv.status === 'human';
              const lastFromAgent = conv.lastMessageFrom === 'nina' || conv.lastMessageFrom === 'human';
              const isSelected = selectedId === conv.id;

              const accentColor = isDani
                ? 'var(--dani)'
                : isHuman
                ? 'var(--success)'
                : conv.status === 'paused'
                ? 'var(--warning)'
                : 'var(--border)';

              return (
                <button
                  key={conv.id}
                  onClick={() => setSelectedId(conv.id)}
                  className="group w-full flex items-stretch rounded-xl overflow-hidden transition-all text-left"
                  style={{
                    background: isSelected ? 'var(--primary-tint)' : 'var(--bg-surface)',
                    border: `1px solid ${isSelected ? 'var(--primary)' : 'var(--border)'}`,
                    boxShadow: isSelected ? 'none' : 'var(--sh-sm)',
                  }}
                >
                  {/* Accent bar lateral */}
                  <div
                    className="w-[3px] shrink-0 transition-all"
                    style={{ background: accentColor }}
                  />

                  <div className="flex items-start gap-2.5 flex-1 px-3 py-2.5 min-w-0">
                    {/* Avatar com status dot */}
                    <div className="relative shrink-0 mt-0.5">
                      <Avatar fallback={conv.contactName ?? `+${conv.contactPhone}`} size="sm" />
                      <span
                        className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2"
                        style={{ background: accentColor, borderColor: 'var(--bg-surface)' }}
                      />
                    </div>

                    {/* Conteúdo */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <span className="text-[13px] font-semibold truncate flex-1" style={{ color: 'var(--text-1)' }}>
                          {conv.contactName ?? `+${conv.contactPhone}`}
                        </span>
                        <span className="text-[10.5px] tabular-nums whitespace-nowrap shrink-0" style={{ color: 'var(--text-3)' }}>
                          {timeAgo(conv.lastMessageAt ?? conv.createdAt)}
                        </span>
                      </div>

                      {/* Badges */}
                      <div className="flex items-center gap-1 mb-0.5 flex-wrap">
                        {isDani && (
                          <span className="text-[9.5px] font-semibold px-1.5 py-0.5 rounded-full" style={{ background: 'var(--dani-bg)', color: 'var(--dani-text)' }}>
                            ✦ Dani
                          </span>
                        )}
                        {isHuman && (
                          <span className="text-[9.5px] font-semibold px-1.5 py-0.5 rounded-full" style={{ background: 'var(--success-bg)', color: 'var(--success)' }}>
                            ● Humano
                          </span>
                        )}
                        {heat && (
                          <span className="text-[9.5px] font-semibold px-1.5 py-0.5 rounded-full" style={{ color: heat.color, border: `1px solid ${heat.color}` }}>
                            {heat.label}
                          </span>
                        )}
                        {conv.intentLabel && conv.intentLabel !== 'curioso' && (
                          <span className="text-[9.5px] font-medium px-1.5 py-0.5 rounded-full" style={{ background: 'var(--bg-sunken)', color: 'var(--text-3)' }}>
                            {INTENT_LABELS[conv.intentLabel] ?? conv.intentLabel}
                          </span>
                        )}
                        {conv.followupState === 'sent' && (
                          <span className="text-[9.5px] font-medium px-1.5 py-0.5 rounded-full" style={{ background: 'var(--dani-bg)', color: 'var(--dani-text)' }}>
                            ↻
                          </span>
                        )}
                      </div>

                      {/* Preview */}
                      <p className="text-[11.5px] truncate leading-snug" style={{ color: 'var(--text-2)' }}>
                        {lastFromAgent && (
                          <span style={{ color: 'var(--text-3)', fontStyle: 'italic' }}>
                            {conv.lastMessageFrom === 'nina' ? 'Dani: ' : 'Bia: '}
                          </span>
                        )}
                        {conv.lastMessage ?? <span style={{ color: 'var(--text-3)' }}>sem mensagens</span>}
                      </p>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* ─── RIGHT: detalhe da conversa ──────────── */}
        <div
          className={`flex-1 min-w-0 flex-col min-h-0 ${selectedId ? 'flex' : 'hidden lg:flex'}`}
          style={{ background: 'var(--bg-app)' }}
        >
          {selectedId ? (
            <ConversationDetailPage
              key={selectedId}
              idProp={selectedId}
              embedded
              onBack={() => setSelectedId(null)}
            />
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-center px-6" style={{ color: 'var(--text-3)' }}>
              <div
                className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4"
                style={{ background: 'var(--bg-subtle)' }}
              >
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
                </svg>
              </div>
              <div className="text-sm font-medium" style={{ color: 'var(--text-2)' }}>
                Selecione uma conversa
              </div>
              <div className="text-xs mt-1 max-w-[260px]">
                Clique numa conversa à esquerda pra ver o histórico e responder como Bia.
              </div>
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}
