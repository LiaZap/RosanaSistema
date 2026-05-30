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
            <button
              onClick={handleSeed}
              className="px-4 py-2 rounded-lg border border-fce-green/40 bg-fce-green/10 text-fce-green text-sm font-semibold"
            >
              Importar conhecimento padrao
            </button>
          )}
          <button
            onClick={openCreate}
            className="px-4 py-2 rounded-lg gradient-pink text-white text-sm font-semibold"
          >
            + Novo chunk
          </button>
        </div>
      }
    >
      <div className="space-y-5">
        {notice && (
          <div className="rounded-lg border border-fce-green/40 bg-fce-green/10 p-3 text-sm text-fce-green">
            {notice}
          </div>
        )}
        {error && (
          <div className="rounded-lg border border-fce-red/40 bg-fce-red/10 p-3 text-sm text-fce-red">
            {error}
          </div>
        )}

        {/* Empty state */}
        {!loading && items.length === 0 && (
          <div className="bg-card/40 border border-border/60 rounded-xl p-8 text-center">
            <p className="text-foreground font-semibold mb-2">Base de conhecimento vazia</p>
            <p className="text-sm text-muted-foreground mb-4">
              A DANI usa esses chunks como RAG: carregamos so os relevantes pra cada turno.
              <br />
              Importe o conhecimento padrao da Filhos com Estilo pra comecar.
            </p>
            <button
              onClick={handleSeed}
              className="px-4 py-2 rounded-lg gradient-pink text-white text-sm font-semibold"
            >
              Importar conhecimento padrao FCE
            </button>
          </div>
        )}

        {/* Category filter */}
        {items.length > 0 && (
          <div className="flex gap-1.5 flex-wrap">
            <button
              onClick={() => setSelectedCategory('all')}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                selectedCategory === 'all'
                  ? 'bg-fce-pink/15 text-fce-pink'
                  : 'bg-card/40 border border-border/60 text-muted-foreground hover:bg-card'
              }`}
            >
              Todos ({items.length})
            </button>
            {CATEGORIES.filter((c) => (countByCategory.get(c.value) ?? 0) > 0).map((c) => (
              <button
                key={c.value}
                onClick={() => setSelectedCategory(c.value)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  selectedCategory === c.value
                    ? 'bg-fce-pink/15 text-fce-pink'
                    : 'bg-card/40 border border-border/60 text-muted-foreground hover:bg-card'
                }`}
              >
                {c.label} ({countByCategory.get(c.value) ?? 0})
              </button>
            ))}
          </div>
        )}

        {/* List */}
        <div className="space-y-2">
          {loading && <p className="text-center text-muted-foreground text-sm py-8">Carregando...</p>}
          {filtered.map((item) => (
            <div
              key={item.id}
              className="bg-card/40 border border-border/60 rounded-xl p-4 hover:border-border transition-colors group"
            >
              <div className="flex items-start justify-between gap-3 mb-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-fce-pink/10 text-fce-pink font-medium">
                      {item.category}
                    </span>
                    {item.alwaysInclude && (
                      <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-yellow-500/15 text-yellow-400 font-medium">
                        sempre
                      </span>
                    )}
                    {!item.isActive && (
                      <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-medium">
                        inativo
                      </span>
                    )}
                    <span className="text-[10px] text-muted-foreground">prio {item.priority}</span>
                  </div>
                  <h3 className="font-semibold text-foreground text-sm">{item.title}</h3>
                  <p className="text-xs text-muted-foreground mt-1 line-clamp-2 whitespace-pre-wrap">
                    {item.content}
                  </p>
                  {item.tags && item.tags.length > 0 && (
                    <div className="flex gap-1 flex-wrap mt-2">
                      {item.tags.map((t) => (
                        <span
                          key={t}
                          className="text-[10px] px-1.5 py-0.5 rounded bg-card border border-border text-muted-foreground font-mono"
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
