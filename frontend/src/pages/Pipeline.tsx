import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import AppShell from '../components/AppShell';
import { Avatar } from '../components/ui/avatar';
import { DaniAvatar } from '../components/ui/DaniAvatar';
import EmptyState from '../components/ui/EmptyState';

interface MeResponse {
  user: { id: string; email: string };
  accounts: Array<{ accountId: string; role: string; accountName: string }>;
}

interface Stage {
  id: string;
  accountId: string;
  name: string;
  position: number;
  color: string | null;
}

interface Deal {
  id: string;
  stageId: string;
  title: string;
  value: string | null;
  expectedCloseDate: string | null;
  notes: string | null;
  contactId: string;
  contactName: string | null;
  contactPhone: string;
  createdByAi: boolean;
  conversationId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SummaryRow {
  stageId: string;
  count: number;
  totalValue: number;
}

function fmtBRL(value: string | number | null): string {
  if (value == null) return '—';
  const n = typeof value === 'string' ? Number(value) : value;
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }).format(n);
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'agora';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d`;
  return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

// Cores estáveis pra stages (caso vier sem color do backend)
const STAGE_COLORS: Record<string, string> = {
  'NOVOS LEADS': 'hsl(var(--stage-new))',
  'EM QUALIFICACAO': 'hsl(var(--stage-qualified))',
  'OPORTUNIDADE': 'hsl(var(--stage-opportunity))',
  'FECHAMENTO': 'hsl(var(--stage-closing))',
  'GANHO': 'hsl(var(--stage-won))',
  'PERDIDO': 'hsl(var(--stage-lost))',
};

function stageColor(stage: Stage): string {
  return stage.color || STAGE_COLORS[stage.name.toUpperCase()] || 'hsl(var(--muted-foreground))';
}

export default function PipelinePage() {
  const navigate = useNavigate();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [accountId, setAccountId] = useState<string>('');
  const [stages, setStages] = useState<Stage[]>([]);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [summary, setSummary] = useState<SummaryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overStageId, setOverStageId] = useState<string | null>(null);

  const [showNewDeal, setShowNewDeal] = useState(false);
  const [newDealStageId, setNewDealStageId] = useState<string>('');
  const [newDeal, setNewDeal] = useState({
    title: '',
    contactName: '',
    contactPhone: '',
    value: '',
    notes: '',
  });
  const [saving, setSaving] = useState(false);

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

  async function loadAll() {
    if (!accountId) return;
    try {
      const [stRes, dlRes, smRes] = await Promise.all([
        api.get<{ stages: Stage[] }>(`/pipeline/stages?accountId=${accountId}`),
        api.get<{ deals: Deal[] }>(`/pipeline/deals?accountId=${accountId}`),
        api.get<{ summary: SummaryRow[] }>(`/pipeline/summary?accountId=${accountId}`),
      ]);
      setStages(stRes.stages);
      setDeals(dlRes.deals);
      setSummary(smRes.summary);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao carregar');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  const [search, setSearch] = useState('');
  const [filterAi, setFilterAi] = useState<'all' | 'ai' | 'human'>('all');

  const filteredDeals = useMemo(() => {
    let arr = deals;
    if (search) {
      const q = search.toLowerCase();
      arr = arr.filter(
        (d) =>
          d.title.toLowerCase().includes(q) ||
          d.contactName?.toLowerCase().includes(q) ||
          d.contactPhone.includes(q),
      );
    }
    if (filterAi === 'ai') arr = arr.filter((d) => d.createdByAi);
    if (filterAi === 'human') arr = arr.filter((d) => !d.createdByAi);
    return arr;
  }, [deals, search, filterAi]);

  const dealsByStage = useMemo(() => {
    const map = new Map<string, Deal[]>();
    for (const stage of stages) map.set(stage.id, []);
    for (const d of filteredDeals) {
      if (!map.has(d.stageId)) map.set(d.stageId, []);
      map.get(d.stageId)!.push(d);
    }
    return map;
  }, [stages, filteredDeals]);

  const summaryByStage = useMemo(() => {
    const map = new Map<string, SummaryRow>();
    for (const s of summary) map.set(s.stageId, s);
    return map;
  }, [summary]);

  const totalValue = useMemo(
    () => summary.reduce((acc, s) => acc + (s.totalValue || 0), 0),
    [summary],
  );

  function handleDragStart(e: React.DragEvent, dealId: string) {
    setDraggingId(dealId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dealId);
  }

  function handleDragOver(e: React.DragEvent, stageId: string) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setOverStageId(stageId);
  }

  function handleDragLeave() {
    setOverStageId(null);
  }

  async function handleDrop(e: React.DragEvent, stageId: string) {
    e.preventDefault();
    const dealId = e.dataTransfer.getData('text/plain');
    setOverStageId(null);
    setDraggingId(null);
    if (!dealId) return;
    const deal = deals.find((d) => d.id === dealId);
    if (!deal || deal.stageId === stageId) return;
    setDeals((prev) => prev.map((d) => (d.id === dealId ? { ...d, stageId } : d)));
    try {
      await api.patch(`/pipeline/deals/${dealId}`, { accountId, stageId });
      await loadAll();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao mover');
      setDeals((prev) => prev.map((d) => (d.id === dealId ? { ...d, stageId: deal.stageId } : d)));
    }
  }

  function openNewDeal(stageId: string) {
    setNewDealStageId(stageId);
    setNewDeal({ title: '', contactName: '', contactPhone: '', value: '', notes: '' });
    setShowNewDeal(true);
  }

  async function handleCreateDeal(e: React.FormEvent) {
    e.preventDefault();
    if (!accountId || !newDeal.title || !newDeal.contactPhone) return;
    setSaving(true);
    try {
      await api.post('/pipeline/deals', {
        accountId,
        stageId: newDealStageId,
        title: newDeal.title,
        contactName: newDeal.contactName || undefined,
        contactPhone: newDeal.contactPhone,
        value: newDeal.value ? Number(newDeal.value) : undefined,
        notes: newDeal.notes || undefined,
      });
      setShowNewDeal(false);
      await loadAll();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao criar');
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteDeal(dealId: string) {
    if (!confirm('Apagar este deal?')) return;
    try {
      await api.delete(`/pipeline/deals/${dealId}?accountId=${accountId}`);
      await loadAll();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao apagar');
    }
  }

  if (loading) {
    return (
      <AppShell title="Pipeline" bare>
        <div className="flex-1 p-4 overflow-x-auto">
          <div className="flex gap-3">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div key={i} className="skeleton w-72 h-[500px] rounded-xl shrink-0" />
            ))}
          </div>
        </div>
      </AppShell>
    );
  }

  void me;

  return (
    <AppShell
      title="Pipeline"
      subtitle={`${deals.length} deals · ${fmtBRL(totalValue)} em valor total`}
      bare
    >
      {error && (
        <div className="p-4">
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        </div>
      )}

      {/* Toolbar: busca + filtros */}
      <div
        className="flex items-center gap-3 px-3 py-2 border-b"
        style={{ borderColor: 'var(--border)', background: 'var(--bg-surface)' }}
      >
        <div className="relative flex-1 max-w-md">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar deal, contato ou telefone..."
            className="input-base text-xs pl-8"
          />
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
            style={{ color: 'var(--text-3)' }}
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
        </div>
        <div className="seg">
          <button aria-pressed={filterAi === 'all'} onClick={() => setFilterAi('all')}>
            Todos
          </button>
          <button aria-pressed={filterAi === 'ai'} onClick={() => setFilterAi('ai')}>
            ✦ DANI
          </button>
          <button aria-pressed={filterAi === 'human'} onClick={() => setFilterAi('human')}>
            Manual
          </button>
        </div>
        <span className="text-xs font-mono" style={{ color: 'var(--text-3)' }}>
          {filteredDeals.length} / {deals.length}
        </span>
      </div>

      {/* Kanban - grid responsivo SEM rolagem lateral */}
      <div className="flex-1 p-2 overflow-hidden">
        <div
          className="grid gap-2 h-full"
          style={{ gridTemplateColumns: `repeat(${Math.max(stages.length, 1)}, minmax(0, 1fr))` }}
        >
          {stages.map((stage) => {
            const stageDeals = dealsByStage.get(stage.id) ?? [];
            const stageSummary = summaryByStage.get(stage.id);
            const isOver = overStageId === stage.id;
            const color = stageColor(stage);
            return (
              <div
                key={stage.id}
                onDragOver={(e) => handleDragOver(e, stage.id)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDrop(e, stage.id)}
                className={`min-w-0 rounded-lg border transition-all flex flex-col ${
                  isOver
                    ? 'border-primary bg-primary/5 shadow-glow'
                    : 'border-border bg-card/30'
                }`}
              >
                {/* Stage header compacto */}
                <div className="p-2 border-b border-border relative">
                  <div
                    className="absolute top-0 left-0 right-0 h-[2px] rounded-t-lg"
                    style={{ background: color }}
                  />
                  <div className="flex items-center justify-between gap-1.5 pt-0.5">
                    <div className="flex-1 min-w-0">
                      <h3 className="font-semibold text-foreground text-[10px] uppercase tracking-wider truncate flex items-center gap-1.5">
                        <span className="badge-dot shrink-0" style={{ background: color }} />
                        <span className="truncate">{stage.name}</span>
                      </h3>
                      <div className="flex items-baseline gap-1 mt-0.5">
                        <span className="text-sm font-bold text-foreground tabular-nums">
                          {stageSummary?.count ?? 0}
                        </span>
                        {(stageSummary?.totalValue ?? 0) > 0 && (
                          <span className="text-[10px] text-fce-green font-medium truncate">
                            {fmtBRL(stageSummary?.totalValue ?? 0)}
                          </span>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={() => openNewDeal(stage.id)}
                      className="w-5 h-5 rounded border border-border hover:bg-card hover:border-border-strong
                                 text-muted-foreground hover:text-foreground text-sm leading-none transition-colors shrink-0"
                      title="Novo deal"
                    >
                      +
                    </button>
                  </div>
                </div>

                {/* Deals scrollable só vertical */}
                <div className="flex-1 p-1.5 space-y-1.5 overflow-y-auto min-h-0">
                  {stageDeals.length === 0 && (
                    <div className="text-center text-[10px] text-muted-foreground py-6 px-2 border border-dashed border-border/60 rounded-md">
                      vazio
                    </div>
                  )}
                  {stageDeals.map((deal) => (
                    <DealCard
                      key={deal.id}
                      deal={deal}
                      dragging={draggingId === deal.id}
                      onDragStart={(e) => handleDragStart(e, deal.id)}
                      onDragEnd={() => setDraggingId(null)}
                      onDelete={() => handleDeleteDeal(deal.id)}
                      accentColor={color}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Empty state se nenhuma stage */}
      {stages.length === 0 && (
        <div className="p-6 max-w-2xl mx-auto">
          <EmptyState
            title="Nenhuma stage configurada"
            description="Inicialize o sistema pra criar as 6 stages padrão (Novos Leads, Em Qualificação, Oportunidade, Fechamento, Ganho, Perdido)."
          />
        </div>
      )}

      {/* Modal Novo Deal */}
      {showNewDeal && (
        <div
          className="fixed inset-0 bg-black/70 backdrop-blur-md flex items-center justify-center p-4 z-50 animate-fade-in"
          onClick={(e) => e.target === e.currentTarget && setShowNewDeal(false)}
        >
          <div className="card-elev bg-card-elevated rounded-xl p-6 max-w-md w-full space-y-4 shadow-md">
            <div>
              <h2 className="text-lg font-semibold text-foreground">Novo deal</h2>
              <p className="text-xs text-muted-foreground mt-1">
                {stages.find((s) => s.id === newDealStageId)?.name}
              </p>
            </div>
            <form onSubmit={handleCreateDeal} className="space-y-3">
              <div>
                <label className="block text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
                  Título
                </label>
                <input
                  type="text"
                  value={newDeal.title}
                  onChange={(e) => setNewDeal({ ...newDeal, title: e.target.value })}
                  placeholder="Ex: Enxoval Smart Baby"
                  required
                  className="input-base"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
                    Nome contato
                  </label>
                  <input
                    type="text"
                    value={newDeal.contactName}
                    onChange={(e) => setNewDeal({ ...newDeal, contactName: e.target.value })}
                    placeholder="Maria"
                    className="input-base"
                  />
                </div>
                <div>
                  <label className="block text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
                    Telefone *
                  </label>
                  <input
                    type="text"
                    value={newDeal.contactPhone}
                    onChange={(e) => setNewDeal({ ...newDeal, contactPhone: e.target.value })}
                    placeholder="5531999999999"
                    required
                    className="input-base font-mono"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
                  Valor (R$)
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={newDeal.value}
                  onChange={(e) => setNewDeal({ ...newDeal, value: e.target.value })}
                  placeholder="475.00"
                  className="input-base"
                />
              </div>
              <div>
                <label className="block text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
                  Notas
                </label>
                <textarea
                  value={newDeal.notes}
                  onChange={(e) => setNewDeal({ ...newDeal, notes: e.target.value })}
                  rows={3}
                  className="input-base resize-none"
                />
              </div>
              <div className="flex gap-2 justify-end pt-2">
                <button
                  type="button"
                  onClick={() => setShowNewDeal(false)}
                  className="btn-secondary btn-md"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={saving || !newDeal.title || !newDeal.contactPhone}
                  className="btn-primary btn-md"
                >
                  {saving ? 'Criando...' : 'Criar deal'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </AppShell>
  );
}

function DealCard({
  deal,
  dragging,
  onDragStart,
  onDragEnd,
  onDelete,
  accentColor,
}: {
  deal: Deal;
  dragging: boolean;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onDelete: () => void;
  accentColor: string;
}) {
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={`group card-elev p-2 cursor-grab active:cursor-grabbing
                  hover:border-border-strong hover:shadow-md transition-all relative overflow-hidden
                  ${dragging ? 'opacity-40 scale-95' : ''}`}
    >
      {/* Filete lateral colorido fino */}
      <div
        className="absolute top-0 left-0 bottom-0 w-[2px] opacity-70"
        style={{ background: accentColor }}
      />
      <div className="pl-1.5 space-y-1">
        <div className="flex items-start justify-between gap-1">
          <h4 className="font-semibold text-foreground text-xs flex-1 leading-snug line-clamp-2">
            {deal.title}
          </h4>
          <div className="flex items-center gap-1 shrink-0">
            {deal.createdByAi && (
              <span
                className="text-[8px] uppercase font-mono font-bold px-1.5 py-0.5 rounded-full"
                style={{
                  background: 'var(--dani-bg)',
                  color: 'var(--dani-text)',
                  letterSpacing: '0.06em',
                }}
                title="Criado automaticamente pela DANI"
              >
                ✦ DANI
              </span>
            )}
            <button
              onClick={onDelete}
              className="text-muted-foreground/60 hover:text-destructive text-[10px]
                         opacity-0 group-hover:opacity-100 transition-opacity"
              title="Apagar"
            >
              ✕
            </button>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {deal.createdByAi ? (
            <DaniAvatar size="sm" />
          ) : (
            <Avatar fallback={deal.contactName ?? deal.contactPhone.slice(-2)} size="sm" />
          )}
          <span className="text-[10px] text-muted-foreground truncate flex-1">
            {deal.contactName ?? `+${deal.contactPhone}`}
          </span>
        </div>
        <div className="flex items-center justify-between gap-1 pt-0.5">
          {deal.value ? (
            <span className="text-xs font-bold text-fce-green tabular-nums truncate">
              {fmtBRL(deal.value)}
            </span>
          ) : (
            <span className="text-[10px] text-muted-foreground">—</span>
          )}
          <span
            className="text-[9px] text-muted-foreground shrink-0"
            title={new Date(deal.updatedAt).toLocaleString('pt-BR')}
          >
            {timeAgo(deal.updatedAt)}
          </span>
        </div>
      </div>
    </div>
  );
}
