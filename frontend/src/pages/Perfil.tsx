import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import AppShell from '../components/AppShell';
import { Avatar } from '../components/ui/avatar';
import { DirSegment, ThemeToggle } from '../components/ui/ThemeControls';

interface MeResponse {
  user: { id: string; email: string; isSuperAdmin: boolean };
  profile: { fullName?: string } | null;
  accounts: Array<{ accountId: string; role: string; accountName: string; accountSlug: string }>;
}

export default function PerfilPage() {
  const navigate = useNavigate();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [fullName, setFullName] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<MeResponse>('/auth/me')
      .then((data) => {
        setMe(data);
        setFullName(data.profile?.fullName ?? '');
        setLoading(false);
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) navigate('/auth');
        setLoading(false);
      });
  }, [navigate]);

  async function handleSaveProfile(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await api.put('/auth/profile', { fullName });
      setNotice('Perfil atualizado.');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao salvar');
    } finally {
      setSaving(false);
    }
  }

  async function handleLogout() {
    if (!confirm('Sair da conta?')) return;
    await api.post('/auth/logout').catch(() => {});
    navigate('/auth');
  }

  const account = me?.accounts[0];

  if (loading) {
    return (
      <AppShell title="Perfil">
        <div className="max-w-3xl mx-auto">
          <div className="skeleton h-32 rounded-lg" />
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell title="Perfil" subtitle="Suas configurações pessoais">
      <div className="max-w-3xl mx-auto space-y-5">
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

        {/* Header identidade */}
        <div className="material p-6 flex items-center gap-5">
          <Avatar
            fallback={fullName || me?.user.email || '??'}
            size="xl"
          />
          <div className="flex-1">
            <h2 className="text-xl font-bold" style={{ color: 'var(--text-1)' }}>
              {fullName || me?.user.email.split('@')[0]}
            </h2>
            <div className="flex items-center gap-2 mt-1">
              <span className="badge b-primary">{account?.role ?? 'sem conta'}</span>
              <span className="text-xs" style={{ color: 'var(--text-3)' }}>
                {me?.user.email}
              </span>
            </div>
          </div>
        </div>

        {/* Dados pessoais */}
        <div className="material p-5">
          <div className="mb-4">
            <h3 className="text-base font-bold" style={{ color: 'var(--text-1)' }}>
              Dados pessoais
            </h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-3)' }}>
              Esses dados aparecem em conversas e relatórios.
            </p>
          </div>

          <form onSubmit={handleSaveProfile} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="field-label">Nome completo</label>
                <input
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  className="input-base"
                  placeholder="Seu nome"
                />
              </div>
              <div>
                <label className="field-label">E-mail</label>
                <input
                  value={me?.user.email ?? ''}
                  disabled
                  className="input-base opacity-60 cursor-not-allowed"
                />
              </div>
            </div>
            <div className="flex justify-end">
              <button type="submit" disabled={saving} className="btn btn-primary btn-md">
                {saving ? 'Salvando...' : 'Salvar alterações'}
              </button>
            </div>
          </form>
        </div>

        {/* Workspace */}
        {account && (
          <div className="material p-5">
            <div className="mb-4">
              <h3 className="text-base font-bold" style={{ color: 'var(--text-1)' }}>
                Workspace
              </h3>
              <p className="text-xs mt-0.5" style={{ color: 'var(--text-3)' }}>
                Conta que você está acessando.
              </p>
            </div>
            <div className="flex items-center gap-4">
              <div
                className="w-14 h-14 rounded-md grid place-items-center font-extrabold text-2xl"
                style={{
                  background: 'linear-gradient(150deg, var(--primary), var(--primary-press))',
                  color: 'var(--text-on-primary)',
                }}
              >
                {account.accountName.charAt(0)}
              </div>
              <div className="flex-1">
                <div className="font-semibold" style={{ color: 'var(--text-1)' }}>
                  {account.accountName}
                </div>
                <div className="text-xs mt-0.5" style={{ color: 'var(--text-3)' }}>
                  Slug: <span className="font-mono">{account.accountSlug}</span> · Role:{' '}
                  <span className="font-medium" style={{ color: 'var(--text-2)' }}>
                    {account.role}
                  </span>
                </div>
              </div>
              <span className="badge b-buyer">Plano ativo</span>
            </div>
          </div>
        )}

        {/* Preferências */}
        <div className="material p-5">
          <div className="mb-4">
            <h3 className="text-base font-bold" style={{ color: 'var(--text-1)' }}>
              Preferências
            </h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-3)' }}>
              Como o sistema aparece pra você.
            </p>
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between p-3 rounded-md" style={{ background: 'var(--bg-subtle)' }}>
              <div>
                <div className="text-sm font-medium" style={{ color: 'var(--text-1)' }}>
                  Tema
                </div>
                <div className="text-xs" style={{ color: 'var(--text-3)' }}>
                  Claro ou escuro
                </div>
              </div>
              <ThemeToggle />
            </div>
            <div className="flex items-center justify-between p-3 rounded-md" style={{ background: 'var(--bg-subtle)' }}>
              <div>
                <div className="text-sm font-medium" style={{ color: 'var(--text-1)' }}>
                  Direção de cor
                </div>
                <div className="text-xs" style={{ color: 'var(--text-3)' }}>
                  Cedro · Índigo · Brasa
                </div>
              </div>
              <DirSegment />
            </div>
          </div>
        </div>

        {/* Sair */}
        <div className="material p-5">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-bold" style={{ color: 'var(--text-1)' }}>
                Sair da conta
              </h3>
              <p className="text-xs mt-0.5" style={{ color: 'var(--text-3)' }}>
                Encerra sua sessão neste navegador.
              </p>
            </div>
            <button onClick={handleLogout} className="btn btn-danger btn-md">
              Sair
            </button>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
