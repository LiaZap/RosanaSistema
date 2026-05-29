import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';

interface MeResponse {
  user: { id: string; email: string };
  accounts: Array<{ accountId: string; role: string; accountName: string }>;
}

interface BlingStatus {
  hasCredentials: boolean;
  connected: boolean;
  expiresAt: string | null;
  productCount: { total: number; available: number };
}

interface SyncResult {
  ok: boolean;
  pagesProcessed: number;
  productsInserted: number;
  productsUpdated: number;
  durationMs: number;
}

// Base URL do backend pro OAuth redirect (start endpoint precisa de redirect server-side)
const API_BASE_URL = import.meta.env.VITE_API_URL || '/api';

export default function BlingPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [accountId, setAccountId] = useState<string>('');
  const [status, setStatus] = useState<BlingStatus | null>(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Recebe notificacoes do callback OAuth via query params
  useEffect(() => {
    const connected = searchParams.get('connected');
    const errorParam = searchParams.get('error');
    if (connected) setNotice('Bling conectado com sucesso!');
    if (errorParam) setError(`OAuth falhou: ${errorParam}`);
    if (connected || errorParam) {
      // Limpa params da URL
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  // Carrega user
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

  async function loadStatus() {
    if (!accountId) return;
    try {
      const data = await api.get<BlingStatus>(`/bling/credentials?accountId=${accountId}`);
      setStatus(data);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao carregar status');
    }
  }

  useEffect(() => {
    loadStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  async function handleSaveCredentials(e: React.FormEvent) {
    e.preventDefault();
    if (!accountId || !clientId || !clientSecret) return;
    setSaving(true);
    setError(null);
    try {
      await api.put('/bling/credentials', { accountId, clientId, clientSecret });
      setClientId('');
      setClientSecret('');
      setNotice('Credenciais salvas. Clique em "Conectar com Bling" pra autorizar.');
      await loadStatus();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao salvar');
    } finally {
      setSaving(false);
    }
  }

  function handleConnect() {
    if (!accountId) return;
    // Redirect server-side -> Bling -> callback no backend
    window.location.href = `${API_BASE_URL}/bling/auth/start?accountId=${accountId}`;
  }

  async function handleSync() {
    if (!accountId) return;
    setSyncing(true);
    setError(null);
    setSyncResult(null);
    try {
      const result = await api.post<SyncResult>('/bling/sync', { accountId });
      setSyncResult(result);
      await loadStatus();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha no sync');
    } finally {
      setSyncing(false);
    }
  }

  async function handleDisconnect() {
    if (!accountId) return;
    if (!confirm('Remover credenciais Bling? Vai precisar reconectar.')) return;
    try {
      await api.delete(`/bling/credentials?accountId=${accountId}`);
      setNotice('Credenciais removidas.');
      await loadStatus();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao remover');
    }
  }

  const callbackUrl = `${API_BASE_URL}/bling/auth/callback`;

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-3xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl gradient-pink flex items-center justify-center">
              <span className="text-white font-bold text-lg">B</span>
            </div>
            <div>
              <h1 className="text-xl font-bold text-foreground">Bling ERP</h1>
              <p className="text-sm text-muted-foreground">
                {me?.accounts[0]?.accountName ?? 'Conta'}
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

        {/* Notice / Error */}
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

        {/* Status */}
        {status && (
          <div className="glass rounded-xl p-5 space-y-3">
            <h2 className="font-semibold text-foreground">Status</h2>
            <div className="grid grid-cols-3 gap-3 text-sm">
              <div>
                <div className="text-muted-foreground text-xs uppercase">Credenciais</div>
                <div className={`font-bold ${status.hasCredentials ? 'text-fce-green' : 'text-fce-red'}`}>
                  {status.hasCredentials ? 'OK' : 'Falta'}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground text-xs uppercase">Conectado</div>
                <div className={`font-bold ${status.connected ? 'text-fce-green' : 'text-fce-red'}`}>
                  {status.connected ? 'Sim' : 'Nao'}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground text-xs uppercase">Produtos</div>
                <div className="font-bold text-foreground">
                  {status.productCount.total}{' '}
                  <span className="text-xs text-muted-foreground">
                    ({status.productCount.available} disponiveis)
                  </span>
                </div>
              </div>
            </div>
            {status.expiresAt && (
              <p className="text-xs text-muted-foreground">
                Token expira em: {new Date(status.expiresAt).toLocaleString('pt-BR')}
              </p>
            )}
          </div>
        )}

        {/* Step 1: Credentials */}
        <div className="glass rounded-xl p-5 space-y-4">
          <div>
            <h2 className="font-semibold text-foreground">1. Credenciais do App Bling</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Crie um app em{' '}
              <a
                href="https://developer.bling.com.br/aplicativos"
                target="_blank"
                rel="noopener noreferrer"
                className="text-fce-pink underline"
              >
                developer.bling.com.br/aplicativos
              </a>
              . Use esse Redirect URI:
            </p>
            <code className="block mt-2 p-2 bg-card border border-border rounded text-xs font-mono break-all">
              {callbackUrl}
            </code>
          </div>

          <form onSubmit={handleSaveCredentials} className="space-y-3">
            <div>
              <label className="block text-xs uppercase text-muted-foreground mb-1">
                Client ID
              </label>
              <input
                type="text"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder={status?.hasCredentials ? '*** ja cadastrado ***' : 'cole o Client ID'}
                className="w-full px-3 py-2 rounded-lg bg-card border border-border
                           text-foreground placeholder:text-muted-foreground text-sm
                           focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div>
              <label className="block text-xs uppercase text-muted-foreground mb-1">
                Client Secret
              </label>
              <input
                type="password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder={status?.hasCredentials ? '*** ja cadastrado ***' : 'cole o Client Secret'}
                className="w-full px-3 py-2 rounded-lg bg-card border border-border
                           text-foreground placeholder:text-muted-foreground text-sm
                           focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <button
              type="submit"
              disabled={saving || !clientId || !clientSecret}
              className="px-4 py-2 rounded-lg border border-border text-sm
                         text-foreground hover:bg-card transition-colors
                         disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {saving ? 'Salvando...' : status?.hasCredentials ? 'Atualizar credenciais' : 'Salvar credenciais'}
            </button>
          </form>
        </div>

        {/* Step 2: Connect */}
        <div className="glass rounded-xl p-5 space-y-3">
          <h2 className="font-semibold text-foreground">2. Conectar via OAuth</h2>
          <p className="text-sm text-muted-foreground">
            Voce sera redirecionado pro Bling pra autorizar o acesso. Apos autorizar, volta pra essa pagina.
          </p>
          <button
            onClick={handleConnect}
            disabled={!status?.hasCredentials}
            className="px-6 py-3 rounded-lg gradient-pink text-white font-semibold
                       disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {status?.connected ? 'Reconectar com Bling' : 'Conectar com Bling'}
          </button>
        </div>

        {/* Step 3: Sync */}
        <div className="glass rounded-xl p-5 space-y-3">
          <h2 className="font-semibold text-foreground">3. Sincronizar catalogo</h2>
          <p className="text-sm text-muted-foreground">
            Importa ate 5000 produtos do Bling pro banco local. Pode demorar 30s-2min.
          </p>
          <button
            onClick={handleSync}
            disabled={!status?.connected || syncing}
            className="px-6 py-3 rounded-lg border border-border text-sm
                       text-foreground hover:bg-card transition-colors
                       disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {syncing ? 'Sincronizando...' : 'Sincronizar agora'}
          </button>

          {syncResult && (
            <div className="mt-3 p-3 rounded-lg bg-fce-green/10 border border-fce-green/30 text-sm">
              <div className="font-semibold text-fce-green">Sync completo</div>
              <div className="text-foreground mt-1">
                {syncResult.productsInserted} inseridos · {syncResult.productsUpdated} atualizados ·{' '}
                {syncResult.pagesProcessed} paginas · {(syncResult.durationMs / 1000).toFixed(1)}s
              </div>
            </div>
          )}
        </div>

        {/* Disconnect */}
        {status?.hasCredentials && (
          <div className="text-center">
            <button
              onClick={handleDisconnect}
              className="text-xs text-muted-foreground hover:text-fce-red transition-colors"
            >
              Remover integração Bling
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
