import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import AppShell from '../components/AppShell';

interface MeResponse {
  user: { id: string; email: string };
  accounts: Array<{ accountId: string; role: string; accountName: string }>;
}

interface MediaItem {
  id: string;
  name: string;
  description: string | null;
  fileUrl: string;
  fileType: string;
  fileSize: number | null;
  tags: string[] | null;
  useCount: number;
  lastUsedAt: string | null;
  createdAt: string;
}

function fileTypeIcon(fileType: string): string {
  const t = fileType.toLowerCase();
  if (t.includes('pdf')) return '📄';
  if (t.includes('image') || t.includes('jpg') || t.includes('png')) return '🖼';
  if (t.includes('video') || t.includes('mp4')) return '🎬';
  if (t.includes('audio') || t.includes('mp3')) return '🎵';
  return '📎';
}

export default function LibraryPage() {
  const navigate = useNavigate();
  const [, setMe] = useState<MeResponse | null>(null);
  const [accountId, setAccountId] = useState<string>('');
  const [items, setItems] = useState<MediaItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [editing, setEditing] = useState<MediaItem | null>(null);
  const [form, setForm] = useState({
    name: '',
    description: '',
    fileUrl: '',
    fileType: 'application/pdf',
    tagsRaw: '',
  });
  const [saving, setSaving] = useState(false);
  const [pickedFile, setPickedFile] = useState<File | null>(null);

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
      const data = await api.get<{ items: MediaItem[] }>(`/library?accountId=${accountId}`);
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

  function openCreate() {
    setEditing(null);
    setShowNew(true);
    setPickedFile(null);
    setForm({
      name: '',
      description: '',
      fileUrl: '',
      fileType: 'application/pdf',
      tagsRaw: '',
    });
  }

  function openEdit(item: MediaItem) {
    setEditing(item);
    setShowNew(true);
    setPickedFile(null);
    setForm({
      name: item.name,
      description: item.description ?? '',
      fileUrl: item.fileUrl,
      fileType: item.fileType,
      tagsRaw: (item.tags ?? []).join(', '),
    });
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!accountId || !form.name) return;
    // Criar: precisa de arquivo OU URL. Editar: campos textuais.
    if (!editing && !pickedFile && !form.fileUrl) {
      setError('Selecione um arquivo ou cole uma URL.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const tags = form.tagsRaw
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);

      if (editing) {
        // Edição: só metadados (PATCH JSON)
        await api.patch(`/library/${editing.id}`, {
          accountId,
          name: form.name,
          description: form.description || undefined,
          fileUrl: form.fileUrl,
          fileType: form.fileType,
          tags,
        });
      } else if (pickedFile) {
        // Criar com upload direto (multipart)
        const fd = new FormData();
        fd.append('file', pickedFile);
        fd.append('accountId', accountId);
        fd.append('name', form.name);
        if (form.description) fd.append('description', form.description);
        await api.postForm('/library/upload', fd);
      } else {
        // Criar via URL (fallback legado)
        await api.post('/library', {
          accountId,
          name: form.name,
          description: form.description || undefined,
          fileUrl: form.fileUrl,
          fileType: form.fileType,
          tags,
        });
      }
      setShowNew(false);
      setPickedFile(null);
      await loadList();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao salvar');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Apagar esse arquivo da biblioteca?')) return;
    try {
      await api.delete(`/library/${id}?accountId=${accountId}`);
      await loadList();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao apagar');
    }
  }

  return (
    <AppShell
      title="Biblioteca de Arquivos"
      subtitle={`${items.length} arquivos · DANI usa via tool enviar_arquivo`}
      actions={
        <button
          onClick={openCreate}
          className="px-3 py-1.5 rounded-md gradient-pink text-white text-xs font-semibold"
        >
          + Adicionar
        </button>
      }
    >
      <div className="space-y-4">
        {error && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {loading && (
          <p className="text-center text-muted-foreground text-sm py-8">Carregando...</p>
        )}

        {!loading && items.length === 0 && (
          <div className="card-base p-8 text-center">
            <p className="text-foreground font-semibold mb-2">Biblioteca vazia</p>
            <p className="text-sm text-muted-foreground mb-4">
              Cadastre PDFs (catálogo), vídeos de produto, áudios explicativos.
              <br />
              A DANI envia esses arquivos automaticamente quando o cliente pede.
            </p>
            <button
              onClick={openCreate}
              className="px-4 py-2 rounded-md gradient-pink text-white text-sm font-semibold"
            >
              + Primeiro arquivo
            </button>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {items.map((item) => (
            <div
              key={item.id}
              className="card-base p-4 group hover:border-border transition-colors"
            >
              <div className="flex items-start gap-3">
                <div className="text-2xl shrink-0">{fileTypeIcon(item.fileType)}</div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="font-semibold text-foreground text-sm flex-1">
                      {item.name}
                    </h3>
                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={() => openEdit(item)}
                        className="text-xs text-primary hover:underline"
                      >
                        Editar
                      </button>
                      <button
                        onClick={() => handleDelete(item.id)}
                        className="text-xs text-destructive hover:underline ml-1"
                      >
                        Apagar
                      </button>
                    </div>
                  </div>
                  {item.description && (
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                      {item.description}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-1 mt-2">
                    {(item.tags ?? []).map((t) => (
                      <span
                        key={t}
                        className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                  <div className="flex items-center gap-3 mt-2 text-[10px] text-muted-foreground">
                    <span>📤 {item.useCount} envios</span>
                    <a
                      href={item.fileUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline"
                    >
                      Ver arquivo
                    </a>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Modal */}
        {showNew && (
          <div
            className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50"
            onClick={(e) => e.target === e.currentTarget && setShowNew(false)}
          >
            <div className="bg-popover border border-border rounded-lg p-6 max-w-md w-full space-y-4">
              <h2 className="text-base font-bold text-foreground">
                {editing ? 'Editar arquivo' : 'Novo arquivo'}
              </h2>
              <form onSubmit={handleSave} className="space-y-3">
                <div>
                  <label className="block text-xs uppercase text-muted-foreground mb-1">
                    Nome *
                  </label>
                  <input
                    type="text"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    required
                    placeholder="Catálogo Enxoval 2026"
                    className="input-base"
                  />
                </div>
                {/* Upload de arquivo direto (ao criar) ou URL read-only (ao editar) */}
                {editing ? (
                  <div>
                    <label className="block text-xs uppercase text-muted-foreground mb-1">
                      Arquivo
                    </label>
                    <a
                      href={form.fileUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="input-base font-mono text-xs flex items-center hover:underline"
                      style={{ color: 'var(--primary)' }}
                    >
                      Ver arquivo atual ↗
                    </a>
                    <p className="text-[10px] text-muted-foreground mt-1">
                      Pra trocar o arquivo, apague e crie um novo.
                    </p>
                  </div>
                ) : (
                  <div>
                    <label className="block text-xs uppercase text-muted-foreground mb-1">
                      Arquivo *
                    </label>
                    <label
                      className="flex flex-col items-center justify-center gap-2 rounded-lg cursor-pointer transition-colors py-6 px-4"
                      style={{
                        border: `2px dashed ${pickedFile ? 'var(--primary)' : 'var(--border-strong)'}`,
                        background: pickedFile ? 'var(--primary-tint)' : 'var(--bg-subtle)',
                      }}
                    >
                      {pickedFile ? (
                        <>
                          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                            <polyline points="14 2 14 8 20 8" />
                          </svg>
                          <div className="text-center">
                            <div className="text-xs font-semibold" style={{ color: 'var(--text-1)' }}>
                              {pickedFile.name}
                            </div>
                            <div className="text-[10px]" style={{ color: 'var(--text-3)' }}>
                              {(pickedFile.size / 1024).toFixed(0)} KB · clique pra trocar
                            </div>
                          </div>
                        </>
                      ) : (
                        <>
                          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                            <polyline points="17 8 12 3 7 8" />
                            <line x1="12" y1="3" x2="12" y2="15" />
                          </svg>
                          <div className="text-center">
                            <div className="text-xs font-medium" style={{ color: 'var(--text-2)' }}>
                              Clique pra selecionar
                            </div>
                            <div className="text-[10px]" style={{ color: 'var(--text-3)' }}>
                              PDF, imagem, vídeo ou áudio · até 25MB
                            </div>
                          </div>
                        </>
                      )}
                      <input
                        type="file"
                        accept=".pdf,image/*,video/*,audio/*"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) {
                            setPickedFile(f);
                            // Auto-preenche nome se vazio
                            if (!form.name) {
                              setForm((prev) => ({ ...prev, name: f.name.replace(/\.[^.]+$/, '') }));
                            }
                          }
                        }}
                      />
                    </label>
                  </div>
                )}
                <div>
                  <label className="block text-xs uppercase text-muted-foreground mb-1">
                    Descrição
                  </label>
                  <textarea
                    value={form.description}
                    onChange={(e) => setForm({ ...form, description: e.target.value })}
                    rows={2}
                    placeholder="Catálogo completo com lista de enxoval e preços"
                    className="input-base"
                  />
                </div>
                <div>
                  <label className="block text-xs uppercase text-muted-foreground mb-1">
                    Tags (separadas por vírgula)
                  </label>
                  <input
                    type="text"
                    value={form.tagsRaw}
                    onChange={(e) => setForm({ ...form, tagsRaw: e.target.value })}
                    placeholder="catalogo, enxoval, pdf"
                    className="input-base font-mono text-xs"
                  />
                </div>
                <div className="flex gap-2 justify-end pt-2">
                  <button
                    type="button"
                    onClick={() => setShowNew(false)}
                    className="px-3 py-1.5 rounded-md border border-border text-xs text-muted-foreground"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    disabled={saving || !form.name || (!editing && !pickedFile && !form.fileUrl)}
                    className="px-4 py-1.5 rounded-md gradient-pink text-white text-xs font-semibold disabled:opacity-40"
                  >
                    {saving ? 'Enviando...' : editing ? 'Salvar' : 'Enviar arquivo'}
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
