import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import AppShell from '../components/AppShell';

interface MeResponse {
  user: { id: string; email: string };
  accounts: Array<{ accountId: string; role: string; accountName: string }>;
}

interface SessionInfo {
  instanceName: string;
  status: 'connected' | 'disconnected' | 'connecting';
  phoneNumber: string | null;
  qrCode: string | null;
}

interface SettingsResponse {
  configured: boolean;
  apiUrl: string | null;
  verifyToken: string | null;
  webhookUrl: string | null;
  session: SessionInfo | null;
}

export default function WhatsAppPage() {
  const navigate = useNavigate();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [accountId, setAccountId] = useState<string>('');
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [apiUrl, setApiUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Manual send (teste)
  const [sendPhone, setSendPhone] = useState('');
  const [sendText, setSendText] = useState('');
  const [sending, setSending] = useState(false);

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
    try {
      const data = await api.get<SettingsResponse>(`/whatsapp/settings?accountId=${accountId}`);
      setSettings(data);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao carregar');
    }
  }

  useEffect(() => {
    loadSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  // Auto-refresh status enquanto connecting/qr-code
  useEffect(() => {
    if (!settings?.session) return;
    if (settings.session.status === 'connected') return;
    const interval = setInterval(async () => {
      try {
        const s = await api.get<{ status: string }>(`/whatsapp/status?accountId=${accountId}`);
        if (s.status === 'connected') {
          await loadSettings();
        }
      } catch {
        // ignore
      }
    }, 5000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.session?.status, accountId]);

  async function handleSaveSettings(e: React.FormEvent) {
    e.preventDefault();
    if (!accountId || !apiUrl || !apiKey) return;
    setSaving(true);
    setError(null);
    try {
      await api.put('/whatsapp/settings', { accountId, apiUrl, apiKey });
      setApiUrl('');
      setApiKey('');
      setNotice('Configuracao Evolution salva.');
      await loadSettings();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao salvar');
    } finally {
      setSaving(false);
    }
  }

  async function handleCreateInstance() {
    if (!accountId) return;
    setCreating(true);
    setError(null);
    try {
      await api.post('/whatsapp/instance', { accountId });
      setNotice('Instancia criada / verificada. Veja QR code abaixo.');
      // Pega QR
      const qr = await api.get<{ qrCode: string | null; state?: string }>(
        `/whatsapp/qr?accountId=${accountId}`,
      );
      await loadSettings();
      if (!qr.qrCode && qr.state !== 'open') {
        setError('QR code nao retornado. Tenta reconectar.');
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao criar instancia');
    } finally {
      setCreating(false);
    }
  }

  async function handleRefreshQr() {
    if (!accountId) return;
    try {
      await api.get(`/whatsapp/qr?accountId=${accountId}`);
      await loadSettings();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao gerar novo QR');
    }
  }

  async function handleLogout() {
    if (!accountId) return;
    if (!confirm('Desconectar instancia WhatsApp?')) return;
    try {
      await api.post('/whatsapp/logout', { accountId });
      setNotice('Desconectado.');
      await loadSettings();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao desconectar');
    }
  }

  async function handleSendTest(e: React.FormEvent) {
    e.preventDefault();
    if (!accountId || !sendPhone || !sendText) return;
    setSending(true);
    setError(null);
    try {
      await api.post('/whatsapp/send', { accountId, phoneNumber: sendPhone, text: sendText });
      setNotice(`Mensagem enviada pra ${sendPhone}`);
      setSendText('');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao enviar');
    } finally {
      setSending(false);
    }
  }

  const statusColor =
    settings?.session?.status === 'connected'
      ? 'text-fce-green'
      : settings?.session?.status === 'connecting'
      ? 'text-yellow-400'
      : 'text-fce-red';

  void me;
  void statusColor; // ainda usado abaixo no JSX dos cards
  return (
    <AppShell title="WhatsApp" subtitle="Integracao Evolution API">
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

        {/* Status */}
        {settings && (
          <div className="glass rounded-xl p-5 space-y-3">
            <h2 className="font-semibold text-foreground">Status</h2>
            <div className="grid grid-cols-3 gap-3 text-sm">
              <div>
                <div className="text-muted-foreground text-xs uppercase">Configurado</div>
                <div className={`font-bold ${settings.configured ? 'text-fce-green' : 'text-fce-red'}`}>
                  {settings.configured ? 'Sim' : 'Nao'}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground text-xs uppercase">Instancia</div>
                <div className={`font-bold ${statusColor}`}>
                  {settings.session?.status ?? 'Sem instancia'}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground text-xs uppercase">Numero</div>
                <div className="font-bold text-foreground">
                  {settings.session?.phoneNumber ?? '—'}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Step 1: Settings */}
        <div className="glass rounded-xl p-5 space-y-4">
          <div>
            <h2 className="font-semibold text-foreground">1. Servidor Evolution</h2>
            <p className="text-sm text-muted-foreground mt-1">
              URL do seu Evolution self-hosted e a API key (master key do servidor).
            </p>
          </div>

          <form onSubmit={handleSaveSettings} className="space-y-3">
            <div>
              <label className="block text-xs uppercase text-muted-foreground mb-1">
                Server URL
              </label>
              <input
                type="url"
                value={apiUrl}
                onChange={(e) => setApiUrl(e.target.value)}
                placeholder={settings?.apiUrl ?? 'https://evolution.seudominio.com'}
                className="w-full px-3 py-2 rounded-lg bg-card border border-border
                           text-foreground text-sm font-mono
                           focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div>
              <label className="block text-xs uppercase text-muted-foreground mb-1">
                API Key
              </label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={settings?.configured ? '*** ja cadastrada ***' : 'master key'}
                className="w-full px-3 py-2 rounded-lg bg-card border border-border
                           text-foreground text-sm font-mono
                           focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <button
              type="submit"
              disabled={saving || !apiUrl || !apiKey}
              className="px-4 py-2 rounded-lg border border-border text-sm
                         text-foreground hover:bg-card transition-colors
                         disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {saving ? 'Salvando...' : settings?.configured ? 'Atualizar' : 'Salvar'}
            </button>
          </form>

          {settings?.webhookUrl && (
            <div className="pt-3 border-t border-border">
              <p className="text-xs text-muted-foreground mb-1">
                Webhook URL (Evolution chama aqui automaticamente)
              </p>
              <code className="block p-2 bg-card border border-border rounded text-xs font-mono break-all">
                {settings.webhookUrl}
              </code>
            </div>
          )}
        </div>

        {/* Step 2: Connect */}
        <div className="glass rounded-xl p-5 space-y-3">
          <h2 className="font-semibold text-foreground">2. Conectar WhatsApp</h2>
          <p className="text-sm text-muted-foreground">
            Cria instancia no Evolution + escaneia QR code com WhatsApp Web.
          </p>
          <div className="flex gap-2">
            <button
              onClick={handleCreateInstance}
              disabled={!settings?.configured || creating}
              className="px-6 py-3 rounded-lg gradient-pink text-white font-semibold
                         disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {creating ? 'Criando...' : settings?.session ? 'Reconectar' : 'Criar instancia'}
            </button>
            {settings?.session && settings.session.status !== 'connected' && (
              <button
                onClick={handleRefreshQr}
                className="px-4 py-3 rounded-lg border border-border text-sm
                           text-foreground hover:bg-card transition-colors"
              >
                Novo QR
              </button>
            )}
            {settings?.session?.status === 'connected' && (
              <button
                onClick={handleLogout}
                className="px-4 py-3 rounded-lg border border-fce-red/40 text-fce-red text-sm
                           hover:bg-fce-red/10 transition-colors"
              >
                Desconectar
              </button>
            )}
          </div>

          {settings?.session?.qrCode && settings.session.status !== 'connected' && (
            <div className="pt-3 border-t border-border">
              <p className="text-sm text-muted-foreground mb-3">
                Escaneia esse QR code no app do WhatsApp em <b>Aparelhos conectados</b>:
              </p>
              <div className="bg-white p-3 rounded-lg inline-block">
                <img
                  src={
                    settings.session.qrCode.startsWith('data:')
                      ? settings.session.qrCode
                      : `data:image/png;base64,${settings.session.qrCode}`
                  }
                  alt="QR Code"
                  className="w-64 h-64"
                />
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                QR atualiza automaticamente. Apos conectar, a pagina recarrega o status.
              </p>
            </div>
          )}
        </div>

        {/* Step 3: Send test */}
        {settings?.session?.status === 'connected' && (
          <div className="glass rounded-xl p-5 space-y-3">
            <h2 className="font-semibold text-foreground">3. Enviar mensagem de teste</h2>
            <form onSubmit={handleSendTest} className="space-y-3">
              <div>
                <label className="block text-xs uppercase text-muted-foreground mb-1">
                  Numero (formato internacional, sem +)
                </label>
                <input
                  type="text"
                  value={sendPhone}
                  onChange={(e) => setSendPhone(e.target.value)}
                  placeholder="5531999999999"
                  className="w-full px-3 py-2 rounded-lg bg-card border border-border
                             text-foreground text-sm font-mono
                             focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <div>
                <label className="block text-xs uppercase text-muted-foreground mb-1">
                  Mensagem
                </label>
                <input
                  type="text"
                  value={sendText}
                  onChange={(e) => setSendText(e.target.value)}
                  placeholder="Oi, teste"
                  className="w-full px-3 py-2 rounded-lg bg-card border border-border
                             text-foreground text-sm
                             focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <button
                type="submit"
                disabled={sending || !sendPhone || !sendText}
                className="px-4 py-2 rounded-lg gradient-pink text-white text-sm font-semibold
                           disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {sending ? 'Enviando...' : 'Enviar'}
              </button>
            </form>
          </div>
        )}
      </div>
    </AppShell>
  );
}
