import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import AppShell from '../components/AppShell';

interface MeResponse {
  user: { id: string; email: string };
  profile: { fullName?: string } | null;
  accounts: Array<{ accountId: string; role: string; accountName: string }>;
}

interface StepStatus {
  step: number;
  done: boolean;
  optional?: boolean;
}

interface OnboardingChecks {
  hasWhatsapp: boolean;
  hasBling: boolean;
  hasCloudinary: boolean;
  hasKbSeeded: boolean;
  hasNinaSettings: boolean;
  productCount: number;
}

const STEPS = [
  {
    id: 1,
    title: 'Bem-vindo',
    desc: 'Conheca a estrutura do sistema',
  },
  {
    id: 2,
    title: 'WhatsApp',
    desc: 'Conectar Evolution API + escanear QR code',
    href: '/whatsapp',
    check: 'hasWhatsapp' as keyof OnboardingChecks,
  },
  {
    id: 3,
    title: 'Bling ERP',
    desc: 'OAuth + sincronizar produtos do catalogo',
    href: '/bling',
    check: 'hasBling' as keyof OnboardingChecks,
  },
  {
    id: 4,
    title: 'Cloudinary',
    desc: 'Hospedar imagens (DANI manda foto via WhatsApp)',
    href: '/cloudinary',
    check: 'hasCloudinary' as keyof OnboardingChecks,
    optional: true,
  },
  {
    id: 5,
    title: 'Personalidade da DANI',
    desc: 'Importar conhecimento e ajustar prompt',
    href: '/knowledge',
    check: 'hasKbSeeded' as keyof OnboardingChecks,
  },
  {
    id: 6,
    title: 'Biblioteca de arquivos',
    desc: 'Subir catalogo PDF, videos, audios',
    href: '/library',
    optional: true,
  },
  {
    id: 7,
    title: 'Teste real',
    desc: 'Mandar mensagem teste pro WhatsApp e ver DANI responder',
    href: '/dani',
  },
];

const ONBOARDING_DONE_KEY = 'fce_onboarding_done';

export default function OnboardingPage() {
  const navigate = useNavigate();
  const [, setMe] = useState<MeResponse | null>(null);
  const [accountId, setAccountId] = useState<string>('');
  const [checks, setChecks] = useState<OnboardingChecks | null>(null);
  const [loading, setLoading] = useState(true);

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

  useEffect(() => {
    if (!accountId) return;
    async function check() {
      try {
        const [wa, bling, cloud, kb] = await Promise.all([
          api.get<{ session?: unknown }>(`/whatsapp/settings?accountId=${accountId}`).catch(() => ({ session: null })),
          api.get<{ connected: boolean; productCount: { total: number } }>(`/bling/credentials?accountId=${accountId}`).catch(() => ({ connected: false, productCount: { total: 0 } })),
          api.get<{ configured: boolean }>(`/cloudinary/credentials?accountId=${accountId}`).catch(() => ({ configured: false })),
          api.get<{ items: Array<unknown> }>(`/knowledge?accountId=${accountId}`).catch(() => ({ items: [] })),
        ]);

        setChecks({
          hasWhatsapp: !!wa.session,
          hasBling: 'connected' in bling ? bling.connected : false,
          hasCloudinary: 'configured' in cloud ? cloud.configured : false,
          hasKbSeeded: kb.items.length > 0,
          hasNinaSettings: false,
          productCount: 'productCount' in bling ? bling.productCount?.total ?? 0 : 0,
        });
      } catch {
        // ignore
      } finally {
        setLoading(false);
      }
    }
    check();
  }, [accountId]);

  function getStepStatus(stepId: number): 'done' | 'pending' | 'current' {
    if (!checks) return 'pending';
    const step = STEPS.find((s) => s.id === stepId);
    if (!step) return 'pending';
    if (stepId === 1) return 'done'; // bem-vindo sempre done
    if (step.check && checks[step.check]) return 'done';
    if (stepId === 7) {
      // Teste real considerado pendente até user marcar done
      return 'pending';
    }
    // Próximo passo a fazer = current
    for (let i = 1; i < stepId; i++) {
      const prev = STEPS.find((s) => s.id === i);
      if (prev?.check && !checks[prev.check] && !prev.optional) {
        return 'pending';
      }
    }
    return 'current';
  }

  function markDone() {
    localStorage.setItem(ONBOARDING_DONE_KEY, '1');
    navigate('/dashboard');
  }

  const totalSteps = STEPS.length;
  const doneSteps = checks
    ? STEPS.filter((s) => {
        if (s.id === 1) return true;
        if (!s.check) return s.optional ? false : false;
        return checks[s.check];
      }).length
    : 0;

  return (
    <AppShell
      title="Onboarding"
      subtitle={`Passo ${doneSteps}/${totalSteps} concluido`}
      actions={
        <button
          onClick={markDone}
          className="px-3 py-1.5 rounded-md border border-border text-xs text-muted-foreground hover:bg-muted"
        >
          Pular
        </button>
      }
    >
      <div className="max-w-2xl mx-auto space-y-3">
        {/* Progress bar */}
        <div className="h-2 bg-muted rounded-full overflow-hidden mb-6">
          <div
            className="h-full gradient-pink transition-all"
            style={{ width: `${(doneSteps / totalSteps) * 100}%` }}
          />
        </div>

        {loading ? (
          <p className="text-center text-muted-foreground text-sm py-8">Verificando...</p>
        ) : (
          STEPS.map((step) => {
            const status = getStepStatus(step.id);
            const isDone = status === 'done';
            const isCurrent = status === 'current';
            return (
              <div
                key={step.id}
                className={`card-base p-4 flex items-center gap-4 transition-colors ${
                  isCurrent ? 'border-primary/40 bg-primary/5' : ''
                }`}
              >
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                    isDone
                      ? 'bg-fce-green text-background'
                      : isCurrent
                      ? 'gradient-pink text-white'
                      : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {isDone ? '✓' : step.id}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold text-foreground text-sm">{step.title}</h3>
                    {step.optional && (
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                        opcional
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">{step.desc}</p>
                  {step.id === 3 && checks && checks.hasBling && (
                    <p className="text-[10px] text-fce-green mt-1">
                      ✓ {checks.productCount} produtos sincronizados
                    </p>
                  )}
                </div>
                {step.href ? (
                  <Link
                    to={step.href}
                    className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${
                      isDone
                        ? 'border border-border text-muted-foreground hover:bg-muted'
                        : 'gradient-pink text-white hover:opacity-90'
                    }`}
                  >
                    {isDone ? 'Revisar' : 'Configurar'}
                  </Link>
                ) : (
                  <span className="text-xs text-muted-foreground">—</span>
                )}
              </div>
            );
          })
        )}

        <div className="pt-6 text-center">
          <button
            onClick={markDone}
            disabled={doneSteps < 4}
            className="px-6 py-2 rounded-md gradient-pink text-white text-sm font-semibold disabled:opacity-40"
          >
            {doneSteps >= 4 ? 'Concluir onboarding' : `Faltam ${4 - doneSteps} passos essenciais`}
          </button>
        </div>
      </div>
    </AppShell>
  );
}
