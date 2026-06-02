import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import AppShell from '../components/AppShell';

interface MeResponse {
  user: { id: string; email: string; isSuperAdmin?: boolean };
  accounts: Array<{ accountId: string; role: string; accountName: string }>;
}

interface NinaSettings {
  id: string;
  accountId: string;
  isActive: boolean;
  autoResponseEnabled: boolean;
  sdrName: string;
  companyName: string | null;
  systemPromptOverride: string | null;
  aiModelMode: string;
  responseDelayMin: number;
  responseDelayMax: number;
  messageBreakingEnabled: boolean;
  audioResponseEnabled: boolean;
}

interface ModelOption {
  key: string;
  label: string;
  model: string;
  badge?: 'recomendado' | 'avancado' | 'experimental';
  superAdminOnly?: boolean;
}

// Modelos visiveis ordenados pelo padrao recomendado primeiro.
// `flash` e a unica opcao livre. Pro/lite/preview ficam restritas ao
// super-admin (FCE/Paulo) por decisao da reuniao 02/06 — evita que
// admin do cliente bagunce a operacao trocando modelo no impulso.
const MODEL_OPTIONS: ModelOption[] = [
  {
    key: 'flash',
    label: 'Flash — gemini-flash-latest (rapido + barato)',
    model: 'gemini-flash-latest',
    badge: 'recomendado',
  },
  {
    key: 'pro',
    label: 'Pro — gemini-pro-latest (mais preciso, mais caro)',
    model: 'gemini-pro-latest',
    badge: 'avancado',
    superAdminOnly: true,
  },
  {
    key: 'lite',
    label: 'Lite — gemini-flash-lite-latest (econ. de token)',
    model: 'gemini-flash-lite-latest',
    superAdminOnly: true,
  },
  {
    key: 'preview',
    label: 'Preview — gemini-2.0-flash (versao fixa)',
    model: 'gemini-2.0-flash',
    badge: 'experimental',
    superAdminOnly: true,
  },
];

export default function AgentSettingsPage() {
  const navigate = useNavigate();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [accountId, setAccountId] = useState<string>('');
  const [settings, setSettings] = useState<NinaSettings | null>(null);
  const [form, setForm] = useState({
    isActive: true,
    sdrName: 'DANI',
    companyName: '',
    systemPromptOverride: '',
    aiModelMode: 'flash',
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const isSuperAdmin = !!me?.user.isSuperAdmin;

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

  async function loadSettings() {
    if (!accountId) return;
    setLoading(true);
    try {
      const data = await api.get<{ settings: NinaSettings | null }>(
        `/dani/settings?accountId=${accountId}`,
      );
      if (data.settings) {
        setSettings(data.settings);
        setForm({
          isActive: data.settings.isActive,
          sdrName: data.settings.sdrName || 'DANI',
          companyName: data.settings.companyName || '',
          systemPromptOverride: data.settings.systemPromptOverride || '',
          aiModelMode: data.settings.aiModelMode || 'flash',
        });
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao carregar');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!accountId) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await api.put<{ settings: NinaSettings }>('/dani/settings', {
        accountId,
        isActive: form.isActive,
        sdrName: form.sdrName,
        companyName: form.companyName || undefined,
        systemPromptOverride: form.systemPromptOverride.trim().length > 100
          ? form.systemPromptOverride
          : null,
        aiModelMode: form.aiModelMode,
      });
      setNotice('Configuracoes salvas! Vai valer pra proximas mensagens.');
      await loadSettings();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao salvar');
    } finally {
      setSaving(false);
    }
  }

  function handleResetPrompt() {
    if (!confirm('Restaurar prompt padrao da DANI? Voce vai perder o override atual.')) return;
    setForm({ ...form, systemPromptOverride: '' });
    setNotice('Prompt restaurado. Clica em Salvar pra aplicar.');
  }

  void me;
  return (
    <AppShell
      title="Configuracao da DANI"
      subtitle="Identidade, modelo IA e prompt customizado"
    >
      <div className="space-y-6">
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

        {loading ? (
          <p className="text-center text-muted-foreground text-sm py-12">Carregando...</p>
        ) : (
          <form onSubmit={handleSave} className="space-y-5">
            {/* Status */}
            <div className="glass rounded-xl p-5 space-y-3">
              <h2 className="font-semibold text-foreground">Status</h2>
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.isActive}
                  onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                  className="w-5 h-5 accent-fce-pink"
                />
                <div>
                  <div className="text-sm font-medium text-foreground">
                    DANI ativa
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Quando desligada, nao responde mensagens automaticamente
                  </div>
                </div>
              </label>
            </div>

            {/* Identidade */}
            <div className="glass rounded-xl p-5 space-y-4">
              <h2 className="font-semibold text-foreground">Identidade</h2>
              <div>
                <label className="block text-xs uppercase text-muted-foreground mb-1">
                  Nome da assistente
                </label>
                <input
                  type="text"
                  value={form.sdrName}
                  onChange={(e) => setForm({ ...form, sdrName: e.target.value })}
                  required
                  maxLength={100}
                  className="w-full px-3 py-2 rounded-lg bg-card border border-border
                             text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Substitui "DANI" em todas as referencias do prompt padrao
                </p>
              </div>
              <div>
                <label className="block text-xs uppercase text-muted-foreground mb-1">
                  Nome da empresa
                </label>
                <input
                  type="text"
                  value={form.companyName}
                  onChange={(e) => setForm({ ...form, companyName: e.target.value })}
                  maxLength={255}
                  placeholder="Filhos com Estilo & Consultorias Rosana Araujo"
                  className="w-full px-3 py-2 rounded-lg bg-card border border-border
                             text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            </div>

            {/* Modelo */}
            <div className="glass rounded-xl p-5 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="font-semibold text-foreground">Modelo IA</h2>
                  <p className="text-[11.5px] mt-0.5" style={{ color: 'var(--text-3)' }}>
                    Padrao da operacao e o Flash. Trocar afeta diretamente o custo e a precisao.
                  </p>
                </div>
                {!isSuperAdmin && (
                  <span
                    className="text-[10.5px] font-semibold px-2 py-0.5 rounded-full inline-flex items-center gap-1 shrink-0"
                    style={{ background: 'var(--warning-bg)', color: 'var(--warning)' }}
                    title="Apenas super-admin pode trocar o modelo"
                  >
                    🔒 travado
                  </span>
                )}
              </div>
              <div className="space-y-2">
                {MODEL_OPTIONS.map((opt) => {
                  const locked = !isSuperAdmin && opt.superAdminOnly;
                  const selected = form.aiModelMode === opt.key;
                  return (
                    <label
                      key={opt.key}
                      className={`flex items-center gap-3 p-2.5 rounded-lg transition-colors ${
                        locked ? 'opacity-40 cursor-not-allowed' : 'hover:bg-card cursor-pointer'
                      } ${selected ? 'border' : 'border border-transparent'}`}
                      style={
                        selected
                          ? { background: 'var(--primary-tint)', borderColor: 'var(--primary)' }
                          : undefined
                      }
                    >
                      <input
                        type="radio"
                        name="aiModelMode"
                        value={opt.key}
                        checked={selected}
                        disabled={locked}
                        onChange={(e) => {
                          if (locked) return;
                          setForm({ ...form, aiModelMode: e.target.value });
                        }}
                        className="w-4 h-4 accent-fce-pink"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium text-foreground capitalize">
                            {opt.key}
                          </span>
                          {opt.badge && (
                            <span
                              className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full uppercase tracking-wide"
                              style={
                                opt.badge === 'recomendado'
                                  ? { background: 'var(--success-bg)', color: 'var(--success)' }
                                  : opt.badge === 'avancado'
                                  ? { background: 'var(--info-bg)', color: 'var(--info)' }
                                  : { background: 'var(--warning-bg)', color: 'var(--warning)' }
                              }
                            >
                              {opt.badge}
                            </span>
                          )}
                          {locked && (
                            <span
                              className="text-[10px] font-semibold"
                              style={{ color: 'var(--text-3)' }}
                            >
                              🔒 super-admin
                            </span>
                          )}
                        </div>
                        <div className="text-xs font-mono mt-0.5" style={{ color: 'var(--text-3)' }}>
                          {opt.label}
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>

            {/* Prompt override */}
            <div className="glass rounded-xl p-5 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold text-foreground">Prompt personalizado</h2>
                {form.systemPromptOverride.length > 0 && (
                  <button
                    type="button"
                    onClick={handleResetPrompt}
                    className="text-xs text-fce-red hover:underline"
                  >
                    Restaurar padrao
                  </button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Deixe em branco pra usar o prompt padrao da Filhos com Estilo.
                Se preencher (minimo 100 chars), substitui TODO o prompt - voce vira responsavel
                por incluir as regras anti-filler. Recomendado: copia o atual e edita.
              </p>
              <textarea
                value={form.systemPromptOverride}
                onChange={(e) => setForm({ ...form, systemPromptOverride: e.target.value })}
                rows={20}
                placeholder="(usando prompt padrao - deixe em branco se nao quer customizar)"
                maxLength={50_000}
                className="w-full px-3 py-2 rounded-lg bg-card border border-border
                           text-foreground text-xs font-mono leading-relaxed
                           focus:outline-none focus:ring-2 focus:ring-ring resize-y"
              />
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{form.systemPromptOverride.length} / 50.000 chars</span>
                <span>
                  {form.systemPromptOverride.length === 0
                    ? 'Padrao FCE'
                    : form.systemPromptOverride.length < 100
                    ? 'Muito curto (precisa 100+)'
                    : 'Override ativo'}
                </span>
              </div>
            </div>

            {/* Settings nao editaveis ainda */}
            {settings && (
              <div className="glass rounded-xl p-5 space-y-2 opacity-70">
                <h2 className="font-semibold text-foreground text-sm">
                  Outras configuracoes (read-only)
                </h2>
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <span className="text-muted-foreground">Resposta automatica:</span>{' '}
                    <span className="text-foreground">
                      {settings.autoResponseEnabled ? 'ON' : 'OFF'}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Quebra mensagens:</span>{' '}
                    <span className="text-foreground">
                      {settings.messageBreakingEnabled ? 'ON' : 'OFF'}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Delay min/max:</span>{' '}
                    <span className="text-foreground">
                      {settings.responseDelayMin}s / {settings.responseDelayMax}s
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Audio resposta:</span>{' '}
                    <span className="text-foreground">
                      {settings.audioResponseEnabled ? 'ON' : 'OFF'}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* Submit */}
            <div className="flex gap-3 justify-end pt-2">
              <Link
                to="/dani"
                className="px-4 py-2 rounded-lg border border-border text-sm
                           text-foreground hover:bg-card"
              >
                Testar chat
              </Link>
              <button
                type="submit"
                disabled={saving}
                className="px-6 py-2.5 rounded-lg gradient-pink text-white text-sm font-semibold
                           disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {saving ? 'Salvando...' : 'Salvar'}
              </button>
            </div>
          </form>
        )}
      </div>
    </AppShell>
  );
}
