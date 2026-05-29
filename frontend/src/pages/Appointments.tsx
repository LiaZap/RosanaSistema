import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';

interface MeResponse {
  user: { id: string; email: string };
  accounts: Array<{ accountId: string; role: string; accountName: string }>;
}

interface Appointment {
  id: string;
  title: string;
  date: string;
  time: string | null;
  duration: number | null;
  type: string | null;
  description: string | null;
  contactId: string | null;
  contactName: string | null;
  contactPhone: string | null;
  createdAt: string;
}

const TYPE_LABELS: Record<string, string> = {
  smart_baby: 'Smart Baby',
  estilosa: 'Estilosa',
  vip: 'VIP',
  concierge: 'Concierge',
  premium: 'Premium',
  visita_loja: 'Visita loja',
  consultation: 'Consulta',
};

function fmtDate(iso: string): { day: string; weekday: string; full: string } {
  const d = new Date(iso);
  return {
    day: d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }),
    weekday: d.toLocaleDateString('pt-BR', { weekday: 'short' }),
    full: d.toLocaleDateString('pt-BR'),
  };
}

function isPast(iso: string): boolean {
  return new Date(iso).getTime() < Date.now();
}

function isToday(iso: string): boolean {
  const d = new Date(iso);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

export default function AppointmentsPage() {
  const navigate = useNavigate();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [accountId, setAccountId] = useState<string>('');
  const [appts, setAppts] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newAppt, setNewAppt] = useState({
    title: '',
    contactName: '',
    contactPhone: '',
    date: '',
    time: '14:00',
    duration: 60,
    type: 'consultation',
    description: '',
  });

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
    try {
      const data = await api.get<{ appointments: Appointment[] }>(
        `/appointments?accountId=${accountId}`,
      );
      setAppts(data.appointments);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao carregar');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  const grouped = useMemo(() => {
    const today: Appointment[] = [];
    const upcoming: Appointment[] = [];
    const past: Appointment[] = [];
    for (const a of appts) {
      if (isPast(a.date)) past.push(a);
      else if (isToday(a.date)) today.push(a);
      else upcoming.push(a);
    }
    return { today, upcoming, past };
  }, [appts]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!accountId || !newAppt.title || !newAppt.date || !newAppt.contactPhone) return;
    setSaving(true);
    setError(null);
    try {
      const dt = new Date(`${newAppt.date}T${newAppt.time}:00`);
      await api.post('/appointments', {
        accountId,
        title: newAppt.title,
        contactName: newAppt.contactName || undefined,
        contactPhone: newAppt.contactPhone,
        date: dt.toISOString(),
        time: newAppt.time,
        duration: newAppt.duration,
        type: newAppt.type,
        description: newAppt.description || undefined,
      });
      setShowNew(false);
      setNewAppt({
        title: '',
        contactName: '',
        contactPhone: '',
        date: '',
        time: '14:00',
        duration: 60,
        type: 'consultation',
        description: '',
      });
      await loadList();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao criar');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Cancelar este agendamento?')) return;
    try {
      await api.delete(`/appointments/${id}?accountId=${accountId}`);
      await loadList();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao cancelar');
    }
  }

  function renderCard(a: Appointment) {
    const d = fmtDate(a.date);
    const typeLabel = TYPE_LABELS[a.type ?? ''] ?? a.type ?? 'Consulta';
    const past = isPast(a.date);
    return (
      <div
        key={a.id}
        className={`glass rounded-xl p-4 flex gap-3 group transition-opacity ${
          past ? 'opacity-60' : ''
        }`}
      >
        {/* Date block */}
        <div className="w-16 shrink-0 text-center pt-1">
          <div className="text-xs uppercase text-muted-foreground">{d.weekday}</div>
          <div className="text-xl font-bold text-foreground leading-tight">
            {d.day.split(' ')[0]}
          </div>
          <div className="text-[10px] uppercase text-muted-foreground">
            {d.day.split(' ')[1]}
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1 min-w-0">
              <h3 className="font-semibold text-foreground truncate">{a.title}</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                <span className="font-mono">{a.time ?? '—'}</span>
                {a.duration ? ` · ${a.duration}min` : ''} · {typeLabel}
              </p>
            </div>
            <button
              onClick={() => handleDelete(a.id)}
              className="text-muted-foreground hover:text-fce-red text-xs
                         opacity-0 group-hover:opacity-100 transition-opacity"
              title="Cancelar"
            >
              ✕
            </button>
          </div>
          <div className="mt-2 text-sm text-muted-foreground flex items-center gap-2">
            <span className="w-5 h-5 rounded-full bg-card border border-border
                             flex items-center justify-center text-[10px] font-bold">
              {(a.contactName?.[0] ?? a.contactPhone?.[0] ?? '?').toUpperCase()}
            </span>
            <span className="truncate">
              {a.contactName ?? a.contactPhone ?? 'Sem contato'}
            </span>
          </div>
          {a.description && (
            <p className="text-xs text-muted-foreground mt-2 line-clamp-2">{a.description}</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-3xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl gradient-pink flex items-center justify-center">
              <span className="text-white font-bold text-lg">📅</span>
            </div>
            <div>
              <h1 className="text-xl font-bold text-foreground">Agendamentos</h1>
              <p className="text-sm text-muted-foreground">
                {me?.accounts[0]?.accountName ?? ''} · {appts.length} agendamentos
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setShowNew(true)}
              className="px-4 py-2 rounded-lg gradient-pink text-white text-sm font-semibold"
            >
              + Novo
            </button>
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
          <div className="rounded-lg border border-fce-red/40 bg-fce-red/10 p-3 text-sm text-fce-red">
            {error}
          </div>
        )}

        {loading && (
          <p className="text-center text-muted-foreground text-sm py-12">Carregando...</p>
        )}

        {!loading && appts.length === 0 && (
          <p className="text-center text-muted-foreground text-sm py-12">
            Nenhum agendamento. DANI pode criar via "criar_agendamento" ou voce clica em + Novo.
          </p>
        )}

        {/* Hoje */}
        {grouped.today.length > 0 && (
          <div className="space-y-2">
            <h2 className="text-xs uppercase text-fce-pink font-semibold tracking-wider">
              Hoje
            </h2>
            {grouped.today.map(renderCard)}
          </div>
        )}

        {/* Proximos */}
        {grouped.upcoming.length > 0 && (
          <div className="space-y-2">
            <h2 className="text-xs uppercase text-muted-foreground font-semibold tracking-wider">
              Proximos
            </h2>
            {grouped.upcoming.map(renderCard)}
          </div>
        )}

        {/* Passados */}
        {grouped.past.length > 0 && (
          <div className="space-y-2">
            <h2 className="text-xs uppercase text-muted-foreground font-semibold tracking-wider">
              Passados
            </h2>
            {grouped.past.map(renderCard)}
          </div>
        )}
      </div>

      {/* Modal */}
      {showNew && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50"
          onClick={(e) => e.target === e.currentTarget && setShowNew(false)}
        >
          <div className="bg-card border border-border rounded-xl p-6 max-w-md w-full space-y-4">
            <h2 className="text-lg font-bold text-foreground">Novo agendamento</h2>
            <form onSubmit={handleCreate} className="space-y-3">
              <div>
                <label className="block text-xs uppercase text-muted-foreground mb-1">
                  Titulo *
                </label>
                <input
                  type="text"
                  value={newAppt.title}
                  onChange={(e) => setNewAppt({ ...newAppt, title: e.target.value })}
                  required
                  placeholder="Consultoria Smart Baby - Maria"
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
                    value={newAppt.contactName}
                    onChange={(e) => setNewAppt({ ...newAppt, contactName: e.target.value })}
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
                    value={newAppt.contactPhone}
                    onChange={(e) => setNewAppt({ ...newAppt, contactPhone: e.target.value })}
                    required
                    placeholder="5531999999999"
                    className="w-full px-3 py-2 rounded-lg bg-background border border-border
                               text-foreground text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs uppercase text-muted-foreground mb-1">
                    Data *
                  </label>
                  <input
                    type="date"
                    value={newAppt.date}
                    onChange={(e) => setNewAppt({ ...newAppt, date: e.target.value })}
                    required
                    className="w-full px-3 py-2 rounded-lg bg-background border border-border
                               text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
                <div>
                  <label className="block text-xs uppercase text-muted-foreground mb-1">
                    Hora
                  </label>
                  <input
                    type="time"
                    value={newAppt.time}
                    onChange={(e) => setNewAppt({ ...newAppt, time: e.target.value })}
                    className="w-full px-3 py-2 rounded-lg bg-background border border-border
                               text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
                <div>
                  <label className="block text-xs uppercase text-muted-foreground mb-1">
                    Duracao
                  </label>
                  <input
                    type="number"
                    value={newAppt.duration}
                    onChange={(e) =>
                      setNewAppt({ ...newAppt, duration: Number(e.target.value) || 60 })
                    }
                    min={15}
                    step={15}
                    className="w-full px-3 py-2 rounded-lg bg-background border border-border
                               text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs uppercase text-muted-foreground mb-1">
                  Tipo
                </label>
                <select
                  value={newAppt.type}
                  onChange={(e) => setNewAppt({ ...newAppt, type: e.target.value })}
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
              <div>
                <label className="block text-xs uppercase text-muted-foreground mb-1">
                  Observacoes
                </label>
                <textarea
                  value={newAppt.description}
                  onChange={(e) => setNewAppt({ ...newAppt, description: e.target.value })}
                  rows={2}
                  className="w-full px-3 py-2 rounded-lg bg-background border border-border
                             text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <div className="flex gap-2 justify-end pt-2">
                <button
                  type="button"
                  onClick={() => setShowNew(false)}
                  className="px-4 py-2 rounded-lg border border-border text-sm
                             text-muted-foreground hover:bg-background"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={saving || !newAppt.title || !newAppt.date || !newAppt.contactPhone}
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
