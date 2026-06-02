import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import AppShell from '../components/AppShell';

interface MeResponse {
  user: { id: string; email: string };
  accounts: Array<{ accountId: string; role: string; accountName: string }>;
}

interface KBItem {
  id: string;
  accountId: string;
  category: string;
  title: string;
  content: string;
  tags: string[] | null;
  priority: number;
  isActive: boolean;
  alwaysInclude: boolean;
  createdAt: string;
  updatedAt: string;
}

const CATEGORIES = [
  { value: 'persona', label: 'Persona', desc: 'Identidade da DANI' },
  { value: 'output_rules', label: 'Regras de output', desc: 'JSON + silencio' },
  { value: 'tool_rules', label: 'Uso de ferramentas', desc: 'Lei da ferramenta' },
  { value: 'vendas', label: 'Tecnicas de venda', desc: 'Quebra de rejeicao' },
  { value: 'consultoria', label: 'Consultorias', desc: 'Smart Baby, Estilosa, VIP...' },
  { value: 'aluguel', label: 'Aluguel', desc: 'Tabela de aluguel' },
  { value: 'produto_especifico', label: 'Produtos especificos', desc: 'Windi, Colic Calm...' },
  { value: 'sinonimo', label: 'Sinonimos', desc: 'Mapeamento de busca' },
  { value: 'similar', label: 'Similares', desc: 'Categorias alternativas' },
  { value: 'fluxo', label: 'Fluxos', desc: 'Foto, escalacao' },
  { value: 'proibido', label: 'Proibido', desc: 'Frases proibidas' },
  { value: 'horario', label: 'Horario / Logistica', desc: 'Horarios + endereco' },
  { value: 'escalacao', label: 'Escalacao', desc: 'Quando passar pra Bia' },
];

export default function KnowledgePage() {
  const navigate = useNavigate();
  const [, setMe] = useState<MeResponse | null>(null);
  const [accountId, setAccountId] = useState<string>('');
  const [items, setItems] = useState<KBItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [seedingDone, setSeedingDone] = useState(false);

  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [editing, setEditing] = useState<KBItem | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    category: 'produto_especifico',
    title: '',
    content: '',
    tagsRaw: '',
    priority: 50,
    isActive: true,
    alwaysInclude: false,
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

  async function loadList() {
    if (!accountId) return;
    setLoading(true);
    try {
      const data = await api.get<{ items: KBItem[] }>(`/knowledge?accountId=${accountId}`);
      setItems(data.items);
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

  const filtered = useMemo(() => {
    if (selectedCategory === 'all') return items;
    return items.filter((i) => i.category === selectedCategory);
  }, [items, selectedCategory]);

  const countByCategory = useMemo(() => {
    const map = new Map<string, number>();
    for (const i of items) map.set(i.category, (map.get(i.category) ?? 0) + 1);
    return map;
  }, [items]);

  async function handleSeed() {
    if (!accountId) return;
    try {
      const res = await api.post<{ inserted: number }>('/knowledge/seed', { accountId });
      setNotice(`Seed completo: ${res.inserted} chunks adicionados.`);
      setSeedingDone(true);
      await loadList();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha no seed');
    }
  }

  function openCreate() {
    setEditing(null);
    setCreating(true);
    setForm({
      category: selectedCategory === 'all' ? 'produto_especifico' : selectedCategory,
      title: '',
      content: '',
      tagsRaw: '',
      priority: 50,
      isActive: true,
      alwaysInclude: false,
    });
  }

  function openEdit(item: KBItem) {
    setEditing(item);
    setCreating(true);
    setForm({
      category: item.category,
      title: item.title,
      content: item.content,
      tagsRaw: (item.tags ?? []).join(', '),
      priority: item.priority,
      isActive: item.isActive,
      alwaysInclude: item.alwaysInclude,
    });
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!accountId) return;
    setSaving(true);
    setError(null);
    try {
      const tags = form.tagsRaw
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);
      const payload = {
        accountId,
        category: form.category,
        title: form.title,
        content: form.content,
        tags,
        priority: form.priority,
        isActive: form.isActive,
        alwaysInclude: form.alwaysInclude,
      };

      if (editing) {
        await api.patch(`/knowledge/${editing.id}`, payload);
      } else {
        await api.post('/knowledge', payload);
      }
      setCreating(false);
      setEditing(null);
      await loadList();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao salvar');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Apagar esse item da base de conhecimento?')) return;
    try {
      await api.delete(`/knowledge/${id}?accountId=${accountId}`);
      await loadList();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao apagar');
    }
  }

  async function handleToggleActive(item: KBItem) {
    try {
      await api.patch(`/knowledge/${item.id}`, {
        accountId,
        isActive: !item.isActive,
      });
      await loadList();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao atualizar');
    }
  }

  return (
    <AppShell
      title="Base de Conhecimento"
      subtitle={`${items.length} chunks · DANI usa como RAG contextual`}
      actions={
        <div className="flex gap-2">
          {items.length === 0 && !seedingDone && (
            <button onClick={handleSeed} className="btn btn-secondary btn-sm">
              Importar padrão
            </button>
          )}
          <button onClick={openCreate} className="btn btn-primary btn-sm">
            + Novo chunk
          </button>
        </div>
      }
    >
      <div className="space-y-5">
        {notice && (
          <div
            className="rounded-md p-3 text-sm"
            style={{
              background: 'var(--success-bg)',
              color: 'var(--success)',
              border: '1px solid color-mix(in oklch, var(--success) 25%, transparent)',
            }}
          >
            {notice}
          </div>
        )}
        {error && (
          <div
            className="rounded-md p-3 text-sm"
            style={{
              background: 'var(--danger-bg)',
              color: 'var(--danger)',
              border: '1px solid color-mix(in oklch, var(--danger) 25%, transparent)',
            }}
          >
            {error}
          </div>
        )}

        {/* Empty state */}
        {!loading && items.length === 0 && (
          <div className="material p-8 text-center">
            <p className="font-semibold mb-2" style={{ color: 'var(--text-1)' }}>
              Base de conhecimento vazia
            </p>
            <p className="text-sm mb-4" style={{ color: 'var(--text-2)' }}>
              A DANI usa esses chunks como RAG: carregamos só os relevantes pra cada turno.
              <br />
              Importe o conhecimento padrão da Filhos com Estilo pra começar.
            </p>
            <button onClick={handleSeed} className="btn btn-primary btn-md">
              Importar conhecimento padrão FCE
            </button>
          </div>
        )}

        {/* Category filter (FilterTabs) */}
        {items.length > 0 && (
          <div className="flex gap-1.5 flex-wrap">
            <button
              onClick={() => setSelectedCategory('all')}
              className="px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
              style={
                selectedCategory === 'all'
                  ? {
                      background: 'var(--primary-tint)',
                      color: 'var(--primary-text)',
                      border: '1px solid color-mix(in oklch, var(--primary) 25%, transparent)',
                    }
                  : {
                      background: 'var(--bg-surface)',
                      color: 'var(--text-2)',
                      border: '1px solid var(--border)',
                    }
              }
            >
              Todos <span className="font-mono opacity-70">({items.length})</span>
            </button>
            {CATEGORIES.filter((c) => (countByCategory.get(c.value) ?? 0) > 0).map((c) => {
              const isActive = selectedCategory === c.value;
              return (
                <button
                  key={c.value}
                  onClick={() => setSelectedCategory(c.value)}
                  className="px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
                  style={
                    isActive
                      ? {
                          background: 'var(--primary-tint)',
                          color: 'var(--primary-text)',
                          border: '1px solid color-mix(in oklch, var(--primary) 25%, transparent)',
                        }
                      : {
                          background: 'var(--bg-surface)',
                          color: 'var(--text-2)',
                          border: '1px solid var(--border)',
                        }
                  }
                >
                  {c.label} <span className="font-mono opacity-70">({countByCategory.get(c.value) ?? 0})</span>
                </button>
              );
            })}
          </div>
        )}

        {/* List */}
        <div className="space-y-2">
          {loading && <p className="text-center text-muted-foreground text-sm py-8">Carregando...</p>}
          {filtered.map((item) => (
            <div key={item.id} className="material lift p-4 group">
              <div className="flex items-start justify-between gap-3 mb-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                    <span className="badge b-primary uppercase">{item.category}</span>
                    {item.alwaysInclude && (
                      <span className="badge b-hot uppercase">sempre</span>
                    )}
                    {!item.isActive && <span className="badge b-neutral uppercase">inativo</span>}
                    <span className="text-[10px] font-mono" style={{ color: 'var(--text-3)' }}>
                      prio {item.priority}
                    </span>
                  </div>
                  <h3
                    className="font-semibold text-[14.5px]"
                    style={{ color: 'var(--text-1)' }}
                  >
                    {item.title}
                  </h3>
                  <p
                    className="text-xs mt-1 line-clamp-2 whitespace-pre-wrap"
                    style={{ color: 'var(--text-2)' }}
                  >
                    {item.content}
                  </p>
                  {item.tags && item.tags.length > 0 && (
                    <div className="flex gap-1 flex-wrap mt-2">
                      {item.tags.map((t) => (
                        <span
                          key={t}
                          className="text-[10px] px-1.5 py-0.5 rounded font-mono"
                          style={{
                            background: 'var(--bg-subtle)',
                            border: '1px solid var(--border)',
                            color: 'var(--text-3)',
                          }}
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => handleToggleActive(item)}
                    className="text-xs text-muted-foreground hover:text-foreground px-2 py-1"
                    title={item.isActive ? 'Desativar' : 'Ativar'}
                  >
                    {item.isActive ? '◉' : '○'}
                  </button>
                  <button
                    onClick={() => openEdit(item)}
                    className="text-xs text-fce-pink hover:underline px-2 py-1"
                  >
                    Editar
                  </button>
                  <button
                    onClick={() => handleDelete(item.id)}
                    className="text-xs text-fce-red hover:underline px-2 py-1"
                  >
                    Apagar
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Modal Edit / Create */}
        {creating && (
          <div
            className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50 overflow-y-auto"
            onClick={(e) => e.target === e.currentTarget && setCreating(false)}
          >
            <div className="bg-card border border-border rounded-xl p-6 max-w-2xl w-full space-y-4 my-8">
              <h2 className="text-lg font-bold text-foreground">
                {editing ? 'Editar chunk' : 'Novo chunk'}
              </h2>
              <form onSubmit={handleSave} className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs uppercase text-muted-foreground mb-1">Categoria *</label>
                    <select
                      value={form.category}
                      onChange={(e) => setForm({ ...form, category: e.target.value })}
                      required
                      className="w-full px-3 py-2 rounded-lg bg-background border border-border text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    >
                      {CATEGORIES.map((c) => (
                        <option key={c.value} value={c.value}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs uppercase text-muted-foreground mb-1">
                      Prioridade (0-100)
                    </label>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={form.priority}
                      onChange={(e) => setForm({ ...form, priority: Number(e.target.value) || 50 })}
                      className="w-full px-3 py-2 rounded-lg bg-background border border-border text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs uppercase text-muted-foreground mb-1">Titulo *</label>
                  <input
                    type="text"
                    value={form.title}
                    onChange={(e) => setForm({ ...form, title: e.target.value })}
                    required
                    className="w-full px-3 py-2 rounded-lg bg-background border border-border text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
                <div>
                  <label className="block text-xs uppercase text-muted-foreground mb-1">
                    Conteudo * (markdown)
                  </label>
                  <textarea
                    value={form.content}
                    onChange={(e) => setForm({ ...form, content: e.target.value })}
                    required
                    rows={10}
                    className="w-full px-3 py-2 rounded-lg bg-background border border-border text-foreground text-xs font-mono focus:outline-none focus:ring-2 focus:ring-ring resize-y"
                  />
                </div>
                <div>
                  <label className="block text-xs uppercase text-muted-foreground mb-1">
                    Tags (separadas por virgula)
                  </label>
                  <input
                    type="text"
                    value={form.tagsRaw}
                    onChange={(e) => setForm({ ...form, tagsRaw: e.target.value })}
                    placeholder="windi, descartavel, frida"
                    className="w-full px-3 py-2 rounded-lg bg-background border border-border text-foreground text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
                <div className="flex gap-4">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.isActive}
                      onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                      className="w-4 h-4 accent-fce-pink"
                    />
                    <span className="text-sm text-foreground">Ativo</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.alwaysInclude}
                      onChange={(e) => setForm({ ...form, alwaysInclude: e.target.checked })}
                      className="w-4 h-4 accent-fce-pink"
                    />
                    <span className="text-sm text-foreground">
                      Sempre incluir (persona, regras absolutas)
                    </span>
                  </label>
                </div>
                <div className="flex gap-2 justify-end pt-2">
                  <button
                    type="button"
                    onClick={() => setCreating(false)}
                    className="px-4 py-2 rounded-lg border border-border text-sm text-muted-foreground"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    disabled={saving || !form.title || !form.content}
                    className="px-4 py-2 rounded-lg gradient-pink text-white text-sm font-semibold disabled:opacity-40"
                  >
                    {saving ? 'Salvando...' : 'Salvar'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}
