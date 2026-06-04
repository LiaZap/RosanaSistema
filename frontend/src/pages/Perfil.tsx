import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import AppShell from '../components/AppShell';
import { Avatar } from '../components/ui/avatar';
import { ThemeToggle } from '../components/ui/ThemeControls';

interface MeResponse {
  user: { id: string; email: string; isSuperAdmin: boolean };
  profile: {
    fullName?: string | null;
    avatarUrl?: string | null;
    phone?: string | null;
  } | null;
  accounts: Array<{ accountId: string; role: string; accountName: string; accountSlug: string }>;
}

export default function PerfilPage() {
  const navigate = useNavigate();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);

  // Dados pessoais
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileNotice, setProfileNotice] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);

  async function handleAvatarFile(file: File) {
    if (!file.type.startsWith('image/')) {
      setProfileError('Selecione uma imagem.');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setProfileError('Imagem maior que 5MB.');
      return;
    }
    setUploadingAvatar(true);
    setProfileError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await api.postForm<{ avatarUrl: string }>('/auth/avatar', fd);
      setAvatarUrl(res.avatarUrl);
      setProfileNotice('Foto atualizada!');
    } catch (e) {
      setProfileError(e instanceof ApiError ? e.message : 'Falha no upload');
    } finally {
      setUploadingAvatar(false);
    }
  }

  // Trocar senha
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordNotice, setPasswordNotice] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<MeResponse>('/auth/me')
      .then((data) => {
        setMe(data);
        setFullName(data.profile?.fullName ?? '');
        setPhone(data.profile?.phone ?? '');
        setAvatarUrl(data.profile?.avatarUrl ?? '');
        setLoading(false);
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) navigate('/auth');
        setLoading(false);
      });
  }, [navigate]);

  async function handleSaveProfile(e: React.FormEvent) {
    e.preventDefault();
    setSavingProfile(true);
    setProfileError(null);
    setProfileNotice(null);
    try {
      await api.put('/auth/profile', {
        fullName: fullName.trim(),
        phone: phone.trim(),
        avatarUrl: avatarUrl.trim() || null,
      });
      setProfileNotice('Perfil atualizado.');
    } catch (e) {
      setProfileError(e instanceof ApiError ? e.message : 'Falha ao salvar');
    } finally {
      setSavingProfile(false);
    }
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    setPasswordError(null);
    setPasswordNotice(null);

    if (newPassword !== confirmPassword) {
      setPasswordError('A confirmação não confere com a nova senha.');
      return;
    }
    if (newPassword.length < 8) {
      setPasswordError('Nova senha precisa ter no mínimo 8 caracteres.');
      return;
    }

    setSavingPassword(true);
    try {
      await api.put('/auth/password', { currentPassword, newPassword });
      setPasswordNotice('Senha alterada com sucesso.');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (e) {
      setPasswordError(e instanceof ApiError ? e.message : 'Falha ao alterar senha');
    } finally {
      setSavingPassword(false);
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
        {/* Header identidade */}
        <div className="material p-6 flex items-center gap-5">
          {/* Avatar clicável com overlay de upload */}
          <label
            className="relative shrink-0 cursor-pointer group"
            title="Trocar foto"
          >
            <Avatar
              fallback={fullName || me?.user.email || '??'}
              src={avatarUrl || null}
              size="xl"
            />
            {/* Overlay no hover */}
            <div
              className="absolute inset-0 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
              style={{ background: 'oklch(0 0 0 / 0.5)' }}
            >
              {uploadingAvatar ? (
                <svg width="20" height="20" className="animate-spin" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" strokeOpacity="0.3" />
                  <path d="M12 2a10 10 0 0 1 10 10" />
                </svg>
              ) : (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                  <circle cx="12" cy="13" r="4" />
                </svg>
              )}
            </div>
            <input
              type="file"
              accept="image/*"
              className="hidden"
              disabled={uploadingAvatar}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleAvatarFile(f);
                e.target.value = '';
              }}
            />
          </label>
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

          {profileNotice && (
            <div
              className="rounded-md p-2.5 text-xs mb-3"
              style={{
                background: 'var(--success-bg)',
                color: 'var(--success)',
                border: '1px solid color-mix(in oklch, var(--success) 25%, transparent)',
              }}
            >
              {profileNotice}
            </div>
          )}
          {profileError && (
            <div
              className="rounded-md p-2.5 text-xs mb-3"
              style={{
                background: 'var(--danger-bg)',
                color: 'var(--danger)',
                border: '1px solid color-mix(in oklch, var(--danger) 25%, transparent)',
              }}
            >
              {profileError}
            </div>
          )}

          <form onSubmit={handleSaveProfile} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="field-label">Nome completo</label>
                <input
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  className="input-base"
                  placeholder="Rosana Araujo"
                />
              </div>
              <div>
                <label className="field-label">Telefone</label>
                <input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className="input-base font-mono"
                  placeholder="+55 31 9 9999-9999"
                />
              </div>
            </div>
            <div>
              <label className="field-label">E-mail</label>
              <input
                value={me?.user.email ?? ''}
                disabled
                className="input-base opacity-60 cursor-not-allowed"
              />
              <p className="text-[10px] mt-1" style={{ color: 'var(--text-3)' }}>
                E-mail não pode ser alterado por aqui. Entre em contato com o suporte.
              </p>
            </div>
            <div>
              <label className="field-label">Foto de perfil</label>
              <div className="flex items-center gap-3">
                <label className="btn btn-secondary btn-sm cursor-pointer">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mr-1">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                  {uploadingAvatar ? 'Enviando…' : avatarUrl ? 'Trocar foto' : 'Enviar foto'}
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    disabled={uploadingAvatar}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) handleAvatarFile(f);
                      e.target.value = '';
                    }}
                  />
                </label>
                {avatarUrl && (
                  <button
                    type="button"
                    onClick={() => setAvatarUrl('')}
                    className="btn btn-ghost btn-sm"
                    style={{ color: 'var(--danger)' }}
                  >
                    Remover
                  </button>
                )}
              </div>
              <p className="text-[10px] mt-1.5" style={{ color: 'var(--text-3)' }}>
                JPG ou PNG até 5MB. A foto é salva direto no sistema. Clique no avatar acima também funciona.
              </p>
            </div>
            <div className="flex justify-end">
              <button type="submit" disabled={savingProfile} className="btn btn-primary btn-md">
                {savingProfile ? 'Salvando...' : 'Salvar alterações'}
              </button>
            </div>
          </form>
        </div>

        {/* Alterar senha */}
        <div className="material p-5">
          <div className="mb-4">
            <h3 className="text-base font-bold" style={{ color: 'var(--text-1)' }}>
              Alterar senha
            </h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-3)' }}>
              Use senhas fortes (mín. 8 caracteres). Recomendamos misturar letras, números e
              símbolos.
            </p>
          </div>

          {passwordNotice && (
            <div
              className="rounded-md p-2.5 text-xs mb-3"
              style={{
                background: 'var(--success-bg)',
                color: 'var(--success)',
                border: '1px solid color-mix(in oklch, var(--success) 25%, transparent)',
              }}
            >
              {passwordNotice}
            </div>
          )}
          {passwordError && (
            <div
              className="rounded-md p-2.5 text-xs mb-3"
              style={{
                background: 'var(--danger-bg)',
                color: 'var(--danger)',
                border: '1px solid color-mix(in oklch, var(--danger) 25%, transparent)',
              }}
            >
              {passwordError}
            </div>
          )}

          <form onSubmit={handleChangePassword} className="space-y-3">
            <div>
              <label className="field-label">Senha atual</label>
              <div className="relative">
                <input
                  type={showCurrent ? 'text' : 'password'}
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  className="input-base pr-10"
                  autoComplete="current-password"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowCurrent((s) => !s)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-xs"
                  style={{ color: 'var(--text-3)' }}
                  tabIndex={-1}
                >
                  {showCurrent ? '◯' : '●'}
                </button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="field-label">Nova senha</label>
                <div className="relative">
                  <input
                    type={showNew ? 'text' : 'password'}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="input-base pr-10"
                    autoComplete="new-password"
                    required
                    minLength={8}
                  />
                  <button
                    type="button"
                    onClick={() => setShowNew((s) => !s)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-xs"
                    style={{ color: 'var(--text-3)' }}
                    tabIndex={-1}
                  >
                    {showNew ? '◯' : '●'}
                  </button>
                </div>
              </div>
              <div>
                <label className="field-label">Confirmar nova senha</label>
                <input
                  type={showNew ? 'text' : 'password'}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="input-base"
                  autoComplete="new-password"
                  required
                  minLength={8}
                />
              </div>
            </div>
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={
                  savingPassword || !currentPassword || !newPassword || !confirmPassword
                }
                className="btn btn-primary btn-md"
              >
                {savingPassword ? 'Alterando...' : 'Alterar senha'}
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
            <div
              className="flex items-center justify-between p-3 rounded-md"
              style={{ background: 'var(--bg-subtle)' }}
            >
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
