import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import AppShell from '../components/AppShell';
import { Avatar } from '../components/ui/avatar';

interface MeResponse {
  user: { id: string; email: string; isSuperAdmin: boolean };
  accounts: Array<{ accountId: string; role: string; accountName: string }>;
}

interface Member {
  memberId: string;
  userId: string;
  email: string;
  fullName: string | null;
  avatarUrl: string | null;
  role: 'owner' | 'admin' | 'manager' | 'sdr';
  status: 'active' | 'inactive';
  isSuperAdmin: boolean;
  joinedAt: string;
}

interface AccountData {
  id: string;
  name: string;
  slug: string;
  members: Member[];
}

const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin AX',
  manager: 'Cliente',
  sdr: 'SDR',
};

const ROLE_COLORS: Record<string, { bg: string; color: string }> = {
  owner:   { bg: 'var(--dani-bg)',     color: 'var(--dani-text)' },
  admin:   { bg: 'var(--info-bg)',     color: 'var(--info)' },
  manager: { bg: 'var(--success-bg)', color: 'var(--success)' },
  sdr:     { bg: 'var(--bg-subtle)',   color: 'var(--text-2)' },
};

const ROLE_DESC: Record<string, string> = {
  owner:   'Acesso total + gerenciar time',
  admin:   'Acesso total (AX team)',
  manager: 'Acesso básico (cliente final)',
  sdr:     'Apenas conversas',
};

export default function AdminUsersPage() {
  const navigate = useNavigate();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [accounts, setAccounts] = useState<AccountData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Modal novo membro
  const [showAdd, setShowAdd] = useState(false);
  const [addAccountId, setAddAccountId] = useState('');
  const [addForm, setAddForm] = useState({
    email: '',
    password: '',
    fullName: '',
    role: 'manager' as Member['role'],
  });
  const [addSaving, setAddSaving] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // Modal editar role
  const [editMember, setEditMember] = useState<{ memberId: string; accountId: string; currentRole: string } | null>(null);
  const [editRole, setEditRole] = useState<Member['role']>('manager');
  const [editSaving, setEditSaving] = useState(false);

  // Modal reset senha
  const [resetUser, setResetUser] = useState<{ userId: string; email: string } | null>(null);
  const [resetPassword, setResetPassword] = useState('');
  const [resetSaving, setResetSaving] = useState(false);

  useEffect(() => {
    api
      .get<MeResponse>('/auth/me')
      .then((data) => {
        setMe(data);
        if (!data.user.isSuperAdmin) {
          navigate('/dashboard');
          return;
        }
        loadAccounts();
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) navigate('/auth');
      });
  }, [navigate]);

  async function loadAccounts() {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<{ accounts: AccountData[] }>('/admin/accounts');
      setAccounts(data.accounts);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Erro ao carregar');
    } finally {
      setLoading(false);
    }
  }

  async function handleAddMember() {
    if (!addForm.email || !addForm.password || !addAccountId) return;
    setAddSaving(true);
    setAddError(null);
    try {
      await api.post(`/admin/accounts/${addAccountId}/members`, addForm);
      setShowAdd(false);
      setAddForm({ email: '', password: '', fullName: '', role: 'manager' });
      await loadAccounts();
    } catch (e) {
      setAddError(e instanceof ApiError ? e.message : 'Erro ao adicionar');
    } finally {
      setAddSaving(false);
    }
  }

  async function handleEditRole() {
    if (!editMember) return;
    setEditSaving(true);
    try {
      await api.patch(`/admin/accounts/${editMember.accountId}/members/${editMember.memberId}`, {
        role: editRole,
      });
      setEditMember(null);
      await loadAccounts();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Erro ao atualizar');
    } finally {
      setEditSaving(false);
    }
  }

  async function handleToggleStatus(accountId: string, memberId: string, currentStatus: string) {
    const newStatus = currentStatus === 'active' ? 'inactive' : 'active';
    try {
      await api.patch(`/admin/accounts/${accountId}/members/${memberId}`, { status: newStatus });
      await loadAccounts();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Erro ao alterar status');
    }
  }

  async function handleRemove(accountId: string, memberId: string, email: string) {
    if (!confirm(`Remover ${email} do account?`)) return;
    try {
      await api.delete(`/admin/accounts/${accountId}/members/${memberId}`);
      await loadAccounts();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Erro ao remover');
    }
  }

  async function handleResetPassword() {
    if (!resetUser || !resetPassword || resetPassword.length < 8) return;
    setResetSaving(true);
    try {
      await api.patch(`/admin/users/${resetUser.userId}/password`, { newPassword: resetPassword });
      setResetUser(null);
      setResetPassword('');
      alert(`Senha de ${resetUser.email} redefinida com sucesso.`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Erro ao redefinir senha');
    } finally {
      setResetSaving(false);
    }
  }

  return (
    <AppShell
      title="Gestão de usuários"
      subtitle="Super-admin · Criar logins, definir papéis, resetar senhas"
      actions={
        accounts.length > 0 ? (
          <button
            onClick={() => {
              setAddAccountId(accounts[0]!.id);
              setShowAdd(true);
            }}
            className="btn btn-primary btn-sm"
          >
            + Novo usuário
          </button>
        ) : undefined
      }
    >
      {error && (
        <div
          className="rounded-lg border p-3 text-sm mb-4"
          style={{ background: 'var(--danger-bg)', color: 'var(--danger)', borderColor: 'var(--danger)' }}
        >
          {error}
          <button className="ml-2 underline text-xs" onClick={() => setError(null)}>fechar</button>
        </div>
      )}

      {loading ? (
        <div className="space-y-3">
          {[1, 2].map((i) => <div key={i} className="skeleton h-32 rounded-xl" />)}
        </div>
      ) : (
        <div className="space-y-8">
          {accounts.map((acc) => (
            <div key={acc.id}>
              {/* Account header */}
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <div
                    className="w-7 h-7 rounded-md flex items-center justify-center text-white text-sm font-bold"
                    style={{ background: 'var(--primary)' }}
                  >
                    {acc.name[0]}
                  </div>
                  <div>
                    <div className="text-[14px] font-semibold" style={{ color: 'var(--text-1)' }}>
                      {acc.name}
                    </div>
                    <div className="text-[11px] font-mono" style={{ color: 'var(--text-3)' }}>
                      slug: {acc.slug} · {acc.members.length} membros
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => { setAddAccountId(acc.id); setShowAdd(true); }}
                  className="btn btn-secondary btn-sm text-xs"
                >
                  + Adicionar
                </button>
              </div>

              {/* Members table */}
              <div className="material overflow-hidden">
                {acc.members.length === 0 ? (
                  <p className="p-6 text-center text-sm" style={{ color: 'var(--text-3)' }}>
                    Nenhum membro. Clique em "+ Adicionar" para criar o primeiro.
                  </p>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--border)' }}>
                        {['Usuário', 'Papel', 'Status', 'Ações'].map((h) => (
                          <th
                            key={h}
                            className="px-4 py-3 text-left text-[11px] uppercase tracking-wider font-semibold"
                            style={{ color: 'var(--text-3)' }}
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {acc.members.map((m, i) => (
                        <tr
                          key={m.memberId}
                          style={{
                            borderBottom: i < acc.members.length - 1 ? '1px solid var(--border)' : 'none',
                          }}
                        >
                          {/* Usuário */}
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2.5">
                              <Avatar
                                fallback={m.fullName ?? m.email}
                                src={m.avatarUrl}
                                size="sm"
                              />
                              <div>
                                <div className="font-medium" style={{ color: 'var(--text-1)' }}>
                                  {m.fullName ?? <span style={{ color: 'var(--text-3)' }}>sem nome</span>}
                                  {m.isSuperAdmin && (
                                    <span
                                      className="ml-1.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
                                      style={{ background: 'var(--dani-bg)', color: 'var(--dani-text)' }}
                                    >
                                      super-admin
                                    </span>
                                  )}
                                </div>
                                <div className="text-[12px] font-mono" style={{ color: 'var(--text-3)' }}>
                                  {m.email}
                                </div>
                              </div>
                            </div>
                          </td>

                          {/* Role */}
                          <td className="px-4 py-3">
                            <button
                              onClick={() => {
                                setEditMember({ memberId: m.memberId, accountId: acc.id, currentRole: m.role });
                                setEditRole(m.role);
                              }}
                              className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-semibold transition-opacity hover:opacity-70"
                              style={{
                                background: ROLE_COLORS[m.role]?.bg ?? 'var(--bg-subtle)',
                                color: ROLE_COLORS[m.role]?.color ?? 'var(--text-2)',
                              }}
                              title="Clique para alterar"
                            >
                              {ROLE_LABELS[m.role] ?? m.role}
                              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                              </svg>
                            </button>
                          </td>

                          {/* Status */}
                          <td className="px-4 py-3">
                            <button
                              onClick={() => handleToggleStatus(acc.id, m.memberId, m.status)}
                              className={`text-[12px] font-semibold px-2 py-0.5 rounded-full transition-opacity hover:opacity-70`}
                              style={
                                m.status === 'active'
                                  ? { background: 'var(--success-bg)', color: 'var(--success)' }
                                  : { background: 'var(--bg-subtle)', color: 'var(--text-3)' }
                              }
                              title="Clique para alternar"
                            >
                              {m.status === 'active' ? '● ativo' : '○ inativo'}
                            </button>
                          </td>

                          {/* Ações */}
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-1">
                              <button
                                onClick={() => { setResetUser({ userId: m.userId, email: m.email }); setResetPassword(''); }}
                                className="btn btn-ghost btn-sm text-xs px-2 py-1"
                                title="Redefinir senha"
                              >
                                🔑 senha
                              </button>
                              {!m.isSuperAdmin && (
                                <button
                                  onClick={() => handleRemove(acc.id, m.memberId, m.email)}
                                  className="btn btn-ghost btn-sm text-xs px-2 py-1"
                                  style={{ color: 'var(--danger)' }}
                                  title="Remover do account"
                                >
                                  remover
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ─── Modal: Novo usuário ──────────────────────── */}
      {showAdd && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: 'oklch(0 0 0 / 0.5)' }}
          onClick={(e) => { if (e.target === e.currentTarget) setShowAdd(false); }}
        >
          <div className="material w-full max-w-md mx-4 p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-base" style={{ color: 'var(--text-1)' }}>
                Novo usuário
              </h2>
              <button onClick={() => setShowAdd(false)} className="btn-ghost btn-sm px-2 py-1 text-lg">×</button>
            </div>

            {addError && (
              <p className="text-sm rounded-lg p-2" style={{ background: 'var(--danger-bg)', color: 'var(--danger)' }}>
                {addError}
              </p>
            )}

            {/* Account selector */}
            {accounts.length > 1 && (
              <div>
                <label className="field-label">Account</label>
                <select
                  value={addAccountId}
                  onChange={(e) => setAddAccountId(e.target.value)}
                  className="input-base"
                >
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              </div>
            )}

            <div>
              <label className="field-label">Nome completo</label>
              <input
                type="text"
                value={addForm.fullName}
                onChange={(e) => setAddForm({ ...addForm, fullName: e.target.value })}
                placeholder="Ex: Rosana Araujo"
                className="input-base"
              />
            </div>
            <div>
              <label className="field-label">Email</label>
              <input
                type="email"
                value={addForm.email}
                onChange={(e) => setAddForm({ ...addForm, email: e.target.value })}
                placeholder="rosana@filhoscomestilo.com.br"
                className="input-base"
                autoComplete="off"
              />
            </div>
            <div>
              <label className="field-label">Senha inicial</label>
              <input
                type="password"
                value={addForm.password}
                onChange={(e) => setAddForm({ ...addForm, password: e.target.value })}
                placeholder="Mínimo 8 caracteres"
                className="input-base"
                autoComplete="new-password"
              />
              <p className="text-xs mt-1" style={{ color: 'var(--text-3)' }}>
                O usuário pode trocar na aba Perfil após o primeiro login.
              </p>
            </div>
            <div>
              <label className="field-label">Papel</label>
              <div className="space-y-2 mt-1">
                {(['owner', 'admin', 'manager', 'sdr'] as const).map((r) => (
                  <label
                    key={r}
                    className="flex items-start gap-2.5 p-2.5 rounded-lg cursor-pointer transition-colors hover:bg-muted"
                    style={
                      addForm.role === r
                        ? { background: ROLE_COLORS[r]?.bg, borderRadius: 8 }
                        : undefined
                    }
                  >
                    <input
                      type="radio"
                      name="role"
                      value={r}
                      checked={addForm.role === r}
                      onChange={() => setAddForm({ ...addForm, role: r })}
                      className="mt-0.5"
                    />
                    <div>
                      <span
                        className="text-sm font-semibold"
                        style={{ color: addForm.role === r ? ROLE_COLORS[r]?.color : 'var(--text-1)' }}
                      >
                        {ROLE_LABELS[r]}
                      </span>
                      <p className="text-xs mt-0.5" style={{ color: 'var(--text-3)' }}>
                        {ROLE_DESC[r]}
                      </p>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            <div className="flex gap-2 justify-end pt-2">
              <button onClick={() => setShowAdd(false)} className="btn btn-secondary btn-sm">
                Cancelar
              </button>
              <button
                onClick={handleAddMember}
                disabled={addSaving || !addForm.email || !addForm.password || !addAccountId}
                className="btn btn-primary btn-sm"
              >
                {addSaving ? 'Criando…' : 'Criar usuário'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Modal: Editar role ───────────────────────── */}
      {editMember && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: 'oklch(0 0 0 / 0.5)' }}
          onClick={(e) => { if (e.target === e.currentTarget) setEditMember(null); }}
        >
          <div className="material w-full max-w-sm mx-4 p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-base" style={{ color: 'var(--text-1)' }}>
                Alterar papel
              </h2>
              <button onClick={() => setEditMember(null)} className="btn-ghost btn-sm px-2 py-1 text-lg">×</button>
            </div>
            <div className="space-y-2">
              {(['owner', 'admin', 'manager', 'sdr'] as const).map((r) => (
                <label
                  key={r}
                  className="flex items-start gap-2.5 p-2.5 rounded-lg cursor-pointer hover:bg-muted"
                  style={editRole === r ? { background: ROLE_COLORS[r]?.bg, borderRadius: 8 } : undefined}
                >
                  <input
                    type="radio"
                    name="editRole"
                    value={r}
                    checked={editRole === r}
                    onChange={() => setEditRole(r)}
                    className="mt-0.5"
                  />
                  <div>
                    <span className="text-sm font-semibold" style={{ color: editRole === r ? ROLE_COLORS[r]?.color : 'var(--text-1)' }}>
                      {ROLE_LABELS[r]}
                    </span>
                    <p className="text-xs mt-0.5" style={{ color: 'var(--text-3)' }}>{ROLE_DESC[r]}</p>
                  </div>
                </label>
              ))}
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setEditMember(null)} className="btn btn-secondary btn-sm">Cancelar</button>
              <button onClick={handleEditRole} disabled={editSaving} className="btn btn-primary btn-sm">
                {editSaving ? 'Salvando…' : 'Salvar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Modal: Reset senha ───────────────────────── */}
      {resetUser && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: 'oklch(0 0 0 / 0.5)' }}
          onClick={(e) => { if (e.target === e.currentTarget) setResetUser(null); }}
        >
          <div className="material w-full max-w-sm mx-4 p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-base" style={{ color: 'var(--text-1)' }}>
                Redefinir senha
              </h2>
              <button onClick={() => setResetUser(null)} className="btn-ghost btn-sm px-2 py-1 text-lg">×</button>
            </div>
            <p className="text-sm" style={{ color: 'var(--text-2)' }}>
              Redefindo senha de <strong>{resetUser.email}</strong>. Informe a nova senha e passe para o usuário.
            </p>
            <div>
              <label className="field-label">Nova senha</label>
              <input
                type="text"
                value={resetPassword}
                onChange={(e) => setResetPassword(e.target.value)}
                placeholder="Mínimo 8 caracteres"
                className="input-base"
                autoComplete="off"
              />
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setResetUser(null)} className="btn btn-secondary btn-sm">Cancelar</button>
              <button
                onClick={handleResetPassword}
                disabled={resetSaving || resetPassword.length < 8}
                className="btn btn-primary btn-sm"
              >
                {resetSaving ? 'Salvando…' : 'Redefinir'}
              </button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
