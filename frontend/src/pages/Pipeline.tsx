import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';

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
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(n);
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

  // Modal de novo deal
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

  const dealsByStage = useMemo(() => {
    const map = new Map<string, Deal[]>();
    for (const stage of stages) map.set(stage.id, []);
    for (const d of deals) {
      if (!map.has(d.stageId)) map.set(d.stageId, []);
      map.get(d.stageId)!.push(d);
    }
    return map;
  }, [stages, deals]);

  const summaryByStage = useMemo(() => {
    const map = new Map<string, SummaryRow>();
    for (const s of summary) map.set(s.stageId, s);
    return map;
  }, [summary]);

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

    // Optimistic
    setDeals((prev) => prev.map((d) => (d.id === dealId ? { ...d, stageId } : d)));
    try {
      await api.patch(`/pipeline/deals/${dealId}`, { accountId, stageId });
      await loadAll();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao mover');
      // Rollback
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
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-muted-foreground text-sm">Carregando pipeline...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b border-border bg-background/80 backdrop-blur p-4 sticky top-0 z-10">
        <div className="max-w-[1400px] mx-auto flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl gradient-pink flex items-center justify-center">
              <span className="text-white font-bold text-lg">P</span>
            </div>
            <div>
              <h1 className="text-xl font-bold text-foreground">Pipeline</h1>
              <p className="text-xs text-muted-foreground">
                {me?.accounts[0]?.accountName ?? ''} · {deals.length} deals
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
      </div>

      {error && (
        <div className="max-w-[1400px] mx-auto p-4">
          <div className="rounded-lg border border-fce-red/40 bg-fce-red/10 p-3 text-sm text-fce-red">
            {error}
          </div>
        </div>
      )}

      {/* Kanban */}
      <div className="p-4 overflow-x-auto">
        <div className="flex gap-3 min-w-min">
          {stages.map((stage) => {
            const stageDeals = dealsByStage.get(stage.id) ?? [];
            const stageSummary = summaryByStage.get(stage.id);
            const isOver = overStageId === stage.id;
            return (
              <div
                key={stage.id}
                onDragOver={(e) => handleDragOver(e, stage.id)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDrop(e, stage.id)}
                className={`flex-shrink-0 w-72 rounded-xl bg-card/50 border transition-colors ${
                  isOver ? 'border-fce-pink bg-fce-pink/10' : 'border-border'
                }`}
              >
                {/* Stage header */}
                <div
                  className="p-3 border-b border-border flex items-center justify-between"
                  style={{ borderTopColor: stage.color ?? '#ccc', borderTopWidth: 3 }}
                >
                  <div>
                    <h3 className="font-semibold text-foreground text-sm uppercase">
                      {stage.name}
                    </h3>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {stageSummary?.count ?? 0} ·{' '}
                      <span className="text-fce-green font-medium">
                        {fmtBRL(stageSummary?.totalValue ?? 0)}
                      </span>
                    </p>
                  </div>
                  <button
                    onClick={() => openNewDeal(stage.id)}
                    className="w-7 h-7 rounded-lg border border-border hover:bg-card
                               text-muted-foreground hover:text-foreground text-lg leading-none"
                    title="Novo deal"
                  >
                    +
                  </button>
                </div>

                {/* Deals */}
                <div className="p-2 space-y-2 min-h-[200px]">
                  {stageDeals.length === 0 && (
                    <div className="text-center text-xs text-muted-foreground py-8">
                      Arraste deals aqui
                    </div>
                  )}
                  {stageDeals.map((deal) => (
                    <div
                      key={deal.id}
                      draggable
                      onDragStart={(e) => handleDragStart(e, deal.id)}
                      onDragEnd={() => setDraggingId(null)}
                      className={`group glass rounded-lg p-3 space-y-1.5 cursor-grab
                                  active:cursor-grabbing transition-opacity ${
                                    draggingId === deal.id ? 'opacity-40' : ''
                                  }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <h4 className="font-semibold text-foreground text-sm flex-1">
                          {deal.title}
                        </h4>
                        <button
                          onClick={() => handleDeleteDeal(deal.id)}
                          className="text-muted-foreground hover:text-fce-red text-xs
                                     opacity-0 group-hover:opacity-100 transition-opacity"
                          title="Apagar"
                        >
                          ✕
                        </button>
                      </div>
                      <div className="text-xs text-muted-foreground flex items-center gap-2">
                        <span className="w-5 h-5 rounded-full bg-card border border-border
                                         flex items-center justify-center text-[10px] font-bold">
                          {(deal.contactName?.[0] ?? deal.contactPhone[0]).toUpperCase()}
                        </span>
                        <span className="truncate">
                          {deal.contactName ?? deal.contactPhone}
                        </span>
                      </div>
                      {deal.value && (
                        <div className="text-sm font-semibold text-fce-green">
                          {fmtBRL(deal.value)}
                        </div>
                      )}
                      {deal.expectedCloseDate && (
                        <div className="text-[10px] text-muted-foreground">
                          🗓 {new Date(deal.expectedCloseDate).toLocaleDateString('pt-BR')}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Modal Novo Deal */}
      {showNewDeal && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50"
          onClick={(e) => e.target === e.currentTarget && setShowNewDeal(false)}
        >
          <div className="bg-card border border-border rounded-xl p-6 max-w-md w-full space-y-4">
            <h2 className="text-lg font-bold text-foreground">Novo deal</h2>
            <form onSubmit={handleCreateDeal} className="space-y-3">
              <div>
                <label className="block text-xs uppercase text-muted-foreground mb-1">Titulo</label>
                <input
                  type="text"
                  value={newDeal.title}
                  onChange={(e) => setNewDeal({ ...newDeal, title: e.target.value })}
                  placeholder="Ex: Enxoval Smart Baby"
                  required
                  className="w-full px-3 py-2 rounded-lg bg-background border border-border
                             text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs uppercase text-muted-foreground mb-1">
                    Nome contato
                  </label>
                  <input
                    type="text"
                    value={newDeal.contactName}
                    onChange={(e) => setNewDeal({ ...newDeal, contactName: e.target.value })}
                    placeholder="Maria"
                    className="w-full px-3 py-2 rounded-lg bg-background border border-border
                               text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
                <div>
                  <label className="block text-xs uppercase text-muted-foreground mb-1">
                    Telefone *
                  </label>
                  <input
                    type="text"
                    value={newDeal.contactPhone}
                    onChange={(e) => setNewDeal({ ...newDeal, contactPhone: e.target.value })}
                    placeholder="5531999999999"
                    required
                    className="w-full px-3 py-2 rounded-lg bg-background border border-border
                               text-foreground text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs uppercase text-muted-foreground mb-1">
                  Valor (R$)
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={newDeal.value}
                  onChange={(e) => setNewDeal({ ...newDeal, value: e.target.value })}
                  placeholder="475.00"
                  className="w-full px-3 py-2 rounded-lg bg-background border border-border
                             text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <div>
                <label className="block text-xs uppercase text-muted-foreground mb-1">
                  Notas
                </label>
                <textarea
                  value={newDeal.notes}
                  onChange={(e) => setNewDeal({ ...newDeal, notes: e.target.value })}
                  rows={3}
                  className="w-full px-3 py-2 rounded-lg bg-background border border-border
                             text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <div className="flex gap-2 justify-end pt-2">
                <button
                  type="button"
                  onClick={() => setShowNewDeal(false)}
                  className="px-4 py-2 rounded-lg border border-border text-sm
                             text-muted-foreground hover:bg-background"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={saving || !newDeal.title || !newDeal.contactPhone}
                  className="px-4 py-2 rounded-lg gradient-pink text-white text-sm font-semibold
                             disabled:opacity-40"
                >
                  {saving ? 'Criando...' : 'Criar'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
