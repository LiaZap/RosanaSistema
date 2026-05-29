import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';

interface MeResponse {
  user: { id: string; email: string };
  accounts: Array<{ accountId: string; role: string; accountName: string }>;
}

interface CloudinaryStatus {
  configured: boolean;
  cloudName: string | null;
  uploadTag: string | null;
  lastSyncAt: string | null;
  productCount: {
    withImage: number;
    uploaded: number;
    pending: number;
  };
}

interface UploadResult {
  ok: boolean;
  processed: number;
  uploaded: number;
  skipped: number;
  failed: number;
  durationMs: number;
  errors?: Array<{ blingId: string | null; error: string }>;
}

export default function CloudinaryPage() {
  const navigate = useNavigate();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [accountId, setAccountId] = useState<string>('');
  const [status, setStatus] = useState<CloudinaryStatus | null>(null);
  const [cloudName, setCloudName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [uploadTag, setUploadTag] = useState('fce_catalogo');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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
      const data = await api.get<CloudinaryStatus>(`/cloudinary/credentials?accountId=${accountId}`);
      setStatus(data);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao carregar');
    }
  }

  useEffect(() => {
    loadStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!accountId) return;
    setSaving(true);
    setError(null);
    try {
      await api.put('/cloudinary/credentials', {
        accountId,
        cloudName,
        apiKey,
        apiSecret,
        uploadTag,
      });
      setNotice('Credenciais validadas e salvas!');
      setCloudName('');
      setApiKey('');
      setApiSecret('');
      await loadStatus();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao salvar');
    } finally {
      setSaving(false);
    }
  }

  async function handleUpload() {
    if (!accountId) return;
    setUploading(true);
    setError(null);
    setUploadResult(null);
    try {
      const result = await api.post<UploadResult>('/cloudinary/upload-pending', {
        accountId,
        maxItems: 200,
      });
      setUploadResult(result);
      await loadStatus();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha no upload');
    } finally {
      setUploading(false);
    }
  }

  async function handleDisconnect() {
    if (!accountId) return;
    if (!confirm('Remover credenciais Cloudinary? URLs ja salvas continuam funcionando.')) return;
    try {
      await api.delete(`/cloudinary/credentials?accountId=${accountId}`);
      setNotice('Credenciais removidas.');
      await loadStatus();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha ao remover');
    }
  }

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-3xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl gradient-pink flex items-center justify-center">
              <span className="text-white font-bold text-lg">☁</span>
            </div>
            <div>
              <h1 className="text-xl font-bold text-foreground">Cloudinary</h1>
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
            <div className="grid grid-cols-4 gap-3 text-sm">
              <div>
                <div className="text-xs uppercase text-muted-foreground">Configurado</div>
                <div className={`font-bold ${status.configured ? 'text-fce-green' : 'text-fce-red'}`}>
                  {status.configured ? 'Sim' : 'Nao'}
                </div>
              </div>
              <div>
                <div className="text-xs uppercase text-muted-foreground">Com img Bling</div>
                <div className="font-bold text-foreground">{status.productCount.withImage}</div>
              </div>
              <div>
                <div className="text-xs uppercase text-muted-foreground">Upload feito</div>
                <div className="font-bold text-fce-green">{status.productCount.uploaded}</div>
              </div>
              <div>
                <div className="text-xs uppercase text-muted-foreground">Pendente</div>
                <div className="font-bold text-yellow-400">{status.productCount.pending}</div>
              </div>
            </div>
            {status.cloudName && (
              <p className="text-xs text-muted-foreground">
                Cloud: <code className="font-mono">{status.cloudName}</code>
                {status.lastSyncAt && (
                  <> · Ultimo upload: {new Date(status.lastSyncAt).toLocaleString('pt-BR')}</>
                )}
              </p>
            )}
          </div>
        )}

        {/* Form */}
        <div className="glass rounded-xl p-5 space-y-4">
          <div>
            <h2 className="font-semibold text-foreground">1. Credenciais Cloudinary</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Acesse{' '}
              <a
                href="https://console.cloudinary.com"
                target="_blank"
                rel="noopener noreferrer"
                className="text-fce-pink underline"
              >
                console.cloudinary.com
              </a>{' '}
              → Dashboard. Copie Cloud Name, API Key e API Secret.
            </p>
          </div>

          <form onSubmit={handleSave} className="space-y-3">
            <div>
              <label className="block text-xs uppercase text-muted-foreground mb-1">
                Cloud Name
              </label>
              <input
                type="text"
                value={cloudName}
                onChange={(e) => setCloudName(e.target.value)}
                placeholder={status?.cloudName ?? 'sua-cloud-name'}
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
                type="text"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={status?.configured ? '*** ja cadastrada ***' : '123456789012345'}
                className="w-full px-3 py-2 rounded-lg bg-card border border-border
                           text-foreground text-sm font-mono
                           focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div>
              <label className="block text-xs uppercase text-muted-foreground mb-1">
                API Secret
              </label>
              <input
                type="password"
                value={apiSecret}
                onChange={(e) => setApiSecret(e.target.value)}
                placeholder={status?.configured ? '*** ja cadastrada ***' : 'api secret'}
                className="w-full px-3 py-2 rounded-lg bg-card border border-border
                           text-foreground text-sm font-mono
                           focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div>
              <label className="block text-xs uppercase text-muted-foreground mb-1">
                Tag de upload
              </label>
              <input
                type="text"
                value={uploadTag}
                onChange={(e) => setUploadTag(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-card border border-border
                           text-foreground text-sm font-mono
                           focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Vamos validar com ping antes de salvar.
            </p>
            <button
              type="submit"
              disabled={saving || !cloudName || !apiKey || !apiSecret}
              className="px-4 py-2 rounded-lg border border-border text-sm
                         text-foreground hover:bg-card transition-colors
                         disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {saving ? 'Validando...' : status?.configured ? 'Atualizar' : 'Salvar e validar'}
            </button>
          </form>
        </div>

        {/* Upload pending */}
        {status?.configured && (
          <div className="glass rounded-xl p-5 space-y-3">
            <h2 className="font-semibold text-foreground">2. Upload de imagens</h2>
            <p className="text-sm text-muted-foreground">
              Faz upload em batch (ate 200 por vez) dos produtos com imagem Bling sem imagem Cloudinary.
              Para a DANI poder mandar foto via WhatsApp.
            </p>
            <button
              onClick={handleUpload}
              disabled={uploading || (status.productCount.pending ?? 0) === 0}
              className="px-6 py-3 rounded-lg gradient-pink text-white font-semibold
                         disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {uploading
                ? 'Enviando...'
                : `Upload ${Math.min(status.productCount.pending, 200)} imagens`}
            </button>

            {uploadResult && (
              <div className="mt-3 p-3 rounded-lg bg-fce-green/10 border border-fce-green/30 text-sm">
                <div className="font-semibold text-fce-green">Upload completo</div>
                <div className="text-foreground mt-1">
                  {uploadResult.uploaded} feitos · {uploadResult.failed} falhas ·{' '}
                  {(uploadResult.durationMs / 1000).toFixed(1)}s
                </div>
                {uploadResult.errors && uploadResult.errors.length > 0 && (
                  <details className="mt-2 text-xs text-muted-foreground">
                    <summary className="cursor-pointer">Ver erros ({uploadResult.errors.length})</summary>
                    <ul className="mt-1 space-y-0.5 font-mono">
                      {uploadResult.errors.map((e, i) => (
                        <li key={i}>
                          {e.blingId}: {e.error}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
          </div>
        )}

        {/* Disconnect */}
        {status?.configured && (
          <div className="text-center">
            <button
              onClick={handleDisconnect}
              className="text-xs text-muted-foreground hover:text-fce-red transition-colors"
            >
              Remover integração Cloudinary
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
