import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import AppShell from '../components/AppShell';
import { Stepper } from '../components/ui/Stepper';
import { ChoiceChips } from '../components/ui/ChoiceChips';
import { DaniAvatar } from '../components/ui/DaniAvatar';

interface MeResponse {
  user: { id: string; email: string };
  profile: { fullName?: string } | null;
  accounts: Array<{ accountId: string; role: string; accountName: string }>;
}

interface OnboardingChecks {
  hasWhatsapp: boolean;
  hasBling: boolean;
  hasCloudinary: boolean;
  hasKbSeeded: boolean;
  productCount: number;
}

const STEP_LABELS = ['Identidade', 'WhatsApp', 'Estoque', 'Conhecimento', 'Revisão'];
const ONBOARDING_DONE_KEY = 'fce_onboarding_done';

export default function OnboardingPage() {
  const navigate = useNavigate();
  const [, setMe] = useState<MeResponse | null>(null);
  const [accountId, setAccountId] = useState<string>('');
  const [checks, setChecks] = useState<OnboardingChecks | null>(null);
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState(0);

  // Step 1 - Identidade
  const [sdrName, setSdrName] = useState('DANI');
  const [companyName, setCompanyName] = useState('Filhos com Estilo');
  const [tone, setTone] = useState('caloroso');

  useEffect(() => {
    api
      .get<MeResponse>('/auth/me')
      .then((data) => {
        setMe(data);
        if (data.accounts[0]) {
          setAccountId(data.accounts[0].accountId);
          setCompanyName(data.accounts[0].accountName);
        }
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
          api
            .get<{ session?: unknown }>(`/whatsapp/settings?accountId=${accountId}`)
            .catch(() => ({ session: null })),
          api
            .get<{ connected: boolean; productCount: { total: number } }>(
              `/bling/credentials?accountId=${accountId}`,
            )
            .catch(() => ({ connected: false, productCount: { total: 0 } })),
          api
            .get<{ configured: boolean }>(`/cloudinary/credentials?accountId=${accountId}`)
            .catch(() => ({ configured: false })),
          api
            .get<{ items: Array<unknown> }>(`/knowledge?accountId=${accountId}`)
            .catch(() => ({ items: [] })),
        ]);
        setChecks({
          hasWhatsapp: !!wa.session,
          hasBling: 'connected' in bling ? bling.connected : false,
          hasCloudinary: 'configured' in cloud ? cloud.configured : false,
          hasKbSeeded: kb.items.length > 0,
          productCount: 'productCount' in bling ? bling.productCount?.total ?? 0 : 0,
        });
      } finally {
        setLoading(false);
      }
    }
    check();
  }, [accountId]);

  function markDone() {
    localStorage.setItem(ONBOARDING_DONE_KEY, '1');
    navigate('/dashboard');
  }

  function next() {
    setStep((s) => Math.min(s + 1, STEP_LABELS.length - 1));
  }
  function prev() {
    setStep((s) => Math.max(s - 1, 0));
  }

  return (
    <AppShell title="Onboarding" subtitle={`Passo ${step + 1} de ${STEP_LABELS.length}`}>
      <div className="max-w-3xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center gap-4">
          <DaniAvatar size="lg" />
          <div>
            <p className="font-mono text-[11px] uppercase font-semibold" style={{ color: 'var(--text-3)', letterSpacing: '.1em' }}>
              Configuração inicial
            </p>
            <h2 className="text-xl font-bold mt-1" style={{ color: 'var(--text-1)' }}>
              Vamos colocar a Dani no ar
            </h2>
          </div>
        </div>

        {/* Stepper */}
        <div className="material p-5">
          <Stepper steps={STEP_LABELS} current={step} />
        </div>

        {/* Step content */}
        <div className="material p-6 min-h-[280px]">
          {loading ? (
            <p className="text-center text-sm py-12" style={{ color: 'var(--text-3)' }}>
              Verificando configuração...
            </p>
          ) : step === 0 ? (
            <StepIdentidade
              sdrName={sdrName}
              setSdrName={setSdrName}
              companyName={companyName}
              setCompanyName={setCompanyName}
              tone={tone}
              setTone={setTone}
            />
          ) : step === 1 ? (
            <StepConnect
              icon="💬"
              title="Conectar WhatsApp"
              desc="Conecte o WhatsApp via Evolution API e escaneie o QR code. A DANI vai começar a receber mensagens dos seus clientes."
              connected={checks?.hasWhatsapp ?? false}
              connectLabel="Configurar WhatsApp"
              href="/whatsapp"
            />
          ) : step === 2 ? (
            <StepEstoque checks={checks} />
          ) : step === 3 ? (
            <StepConhecimento checks={checks} />
          ) : (
            <StepRevisao checks={checks} sdrName={sdrName} tone={tone} />
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 pt-2">
          <div className="flex gap-2">
            <button
              onClick={prev}
              disabled={step === 0}
              className="btn btn-secondary btn-md disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Voltar
            </button>
            <button onClick={markDone} className="btn btn-ghost btn-md">
              Pular configuração
            </button>
          </div>
          {step < STEP_LABELS.length - 1 ? (
            <button onClick={next} className="btn btn-primary btn-md">
              Continuar →
            </button>
          ) : (
            <button onClick={markDone} className="btn btn-primary btn-md">
              Ativar a Dani ✦
            </button>
          )}
        </div>
      </div>
    </AppShell>
  );
}

// ── STEP COMPONENTS ─────────────────────────────────

function StepIdentidade({
  sdrName,
  setSdrName,
  companyName,
  setCompanyName,
  tone,
  setTone,
}: {
  sdrName: string;
  setSdrName: (v: string) => void;
  companyName: string;
  setCompanyName: (v: string) => void;
  tone: string;
  setTone: (v: string) => void;
}) {
  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-lg font-bold mb-1" style={{ color: 'var(--text-1)' }}>
          Identidade da assistente
        </h3>
        <p className="text-sm" style={{ color: 'var(--text-2)' }}>
          Defina o nome e o tom de voz que a Dani vai usar com seus clientes.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="field-label">Nome da assistente</label>
          <input
            value={sdrName}
            onChange={(e) => setSdrName(e.target.value)}
            className="input-base"
          />
        </div>
        <div>
          <label className="field-label">Nome da empresa</label>
          <input
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            className="input-base"
          />
        </div>
      </div>

      <div>
        <label className="field-label">Tom de voz</label>
        <ChoiceChips
          value={tone}
          onChange={setTone}
          choices={[
            { value: 'caloroso', label: 'Caloroso', desc: 'Próximo e acolhedor 🤍' },
            { value: 'direto', label: 'Direto', desc: 'Comercial e objetivo' },
            { value: 'consultivo', label: 'Consultivo', desc: 'Orienta e recomenda' },
          ]}
        />
      </div>
    </div>
  );
}

function StepConnect({
  icon,
  title,
  desc,
  connected,
  connectLabel,
  href,
}: {
  icon: string;
  title: string;
  desc: string;
  connected: boolean;
  connectLabel: string;
  href: string;
}) {
  return (
    <div className="space-y-5">
      <div className="flex items-start gap-4">
        <div
          className="w-14 h-14 rounded-lg grid place-items-center text-3xl"
          style={{
            background: connected ? 'var(--success-bg)' : 'var(--bg-subtle)',
            border: `1px solid ${connected ? 'color-mix(in oklch, var(--success) 25%, transparent)' : 'var(--border)'}`,
          }}
        >
          {icon}
        </div>
        <div className="flex-1">
          <h3 className="text-lg font-bold" style={{ color: 'var(--text-1)' }}>
            {title}
          </h3>
          <p className="text-sm mt-1" style={{ color: 'var(--text-2)' }}>
            {desc}
          </p>
        </div>
      </div>

      <div
        className="flex items-center justify-between gap-3 p-4 rounded-md border"
        style={{
          background: connected ? 'var(--success-bg)' : 'var(--bg-app)',
          borderColor: connected
            ? 'color-mix(in oklch, var(--success) 25%, transparent)'
            : 'var(--border)',
        }}
      >
        <div className="flex items-center gap-3">
          {connected ? (
            <span
              className="w-7 h-7 rounded-full grid place-items-center"
              style={{ background: 'var(--success)', color: 'white' }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6">
                <path d="M5 12l5 5L20 6" />
              </svg>
            </span>
          ) : (
            <span
              className="w-7 h-7 rounded-full grid place-items-center"
              style={{
                background: 'var(--warning-bg)',
                color: 'var(--warning)',
                border: '1px solid color-mix(in oklch, var(--warning) 25%, transparent)',
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3 2" />
              </svg>
            </span>
          )}
          <span className="text-sm font-medium" style={{ color: 'var(--text-1)' }}>
            {connected ? 'Configurado e pronto' : 'Pendente de configuração'}
          </span>
        </div>
        <Link to={href} className="btn btn-primary btn-sm">
          {connected ? 'Revisar' : connectLabel}
        </Link>
      </div>
    </div>
  );
}

function StepEstoque({ checks }: { checks: OnboardingChecks | null }) {
  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-lg font-bold" style={{ color: 'var(--text-1)' }}>
          Conectar estoque
        </h3>
        <p className="text-sm mt-1" style={{ color: 'var(--text-2)' }}>
          Sincronize seu catálogo do Bling pra DANI poder consultar produtos, preços e estoque.
        </p>
      </div>

      {[
        {
          icon: '📦',
          title: 'Bling ERP',
          desc: 'Catálogo de produtos + estoque em tempo real',
          connected: checks?.hasBling ?? false,
          href: '/bling',
          required: true,
          extra: checks?.hasBling ? `${checks.productCount} produtos sincronizados` : undefined,
        },
        {
          icon: '☁️',
          title: 'Cloudinary',
          desc: 'Imagens dos produtos (opcional)',
          connected: checks?.hasCloudinary ?? false,
          href: '/cloudinary',
          required: false,
          extra: undefined,
        },
      ].map((row) => (
        <div
          key={row.title}
          className="flex items-center gap-3 p-4 rounded-md"
          style={{
            background: 'var(--bg-app)',
            border: '1px solid var(--border)',
          }}
        >
          <div className="text-2xl">{row.icon}</div>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold" style={{ color: 'var(--text-1)' }}>
                {row.title}
              </span>
              {!row.required && <span className="badge b-neutral text-[10px]">opcional</span>}
              {row.connected && (
                <span className="badge b-buyer">
                  <span className="badge-dot" style={{ background: 'var(--success)' }} /> conectado
                </span>
              )}
            </div>
            <div className="text-xs mt-0.5" style={{ color: 'var(--text-3)' }}>
              {row.connected && row.extra ? row.extra : row.desc}
            </div>
          </div>
          <Link to={row.href} className="btn btn-secondary btn-sm">
            {row.connected ? 'Revisar' : 'Conectar'}
          </Link>
        </div>
      ))}
    </div>
  );
}

function StepConhecimento({ checks }: { checks: OnboardingChecks | null }) {
  const hasKb = checks?.hasKbSeeded ?? false;
  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-lg font-bold" style={{ color: 'var(--text-1)' }}>
          Personalidade da Dani
        </h3>
        <p className="text-sm mt-1" style={{ color: 'var(--text-2)' }}>
          Importe a base de conhecimento padrão da FCE (16+ chunks) ou comece do zero.
        </p>
      </div>

      <div
        className="p-4 rounded-md"
        style={{
          background: 'var(--primary-tint)',
          border: '1px solid color-mix(in oklch, var(--primary) 25%, var(--border))',
        }}
      >
        <div className="font-bold text-sm mb-2" style={{ color: 'var(--primary-text)' }}>
          Modelo FCE inclui:
        </div>
        <ul className="space-y-1.5 text-sm" style={{ color: 'var(--text-2)' }}>
          {[
            'Persona DANI: vendedora consultiva caloroso',
            'Tabela de aluguel (17 produtos × 3 períodos)',
            '5 consultorias (Smart Baby, Estilosa, VIP, Concierge, Premium)',
            'Conhecimento de Windi, Colic Calm, resfriado',
            'Regras de escalação pra Bia',
            'Horário comercial + endereço da loja',
          ].map((item) => (
            <li key={item} className="flex items-start gap-2">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                className="mt-0.5 shrink-0"
                style={{ color: 'var(--primary)' }}
              >
                <path d="M5 12l5 5L20 6" />
              </svg>
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </div>

      <Link
        to="/knowledge"
        className={`flex items-center justify-between p-4 rounded-md border ${hasKb ? '' : 'btn-primary'}`}
        style={
          hasKb
            ? {
                background: 'var(--success-bg)',
                borderColor: 'color-mix(in oklch, var(--success) 25%, transparent)',
              }
            : { textDecoration: 'none' }
        }
      >
        <span className="font-medium text-sm">
          {hasKb ? `✓ Base de conhecimento ativa` : 'Importar base FCE'}
        </span>
        <span className="text-xs">→</span>
      </Link>
    </div>
  );
}

function StepRevisao({
  checks,
  sdrName,
  tone,
}: {
  checks: OnboardingChecks | null;
  sdrName: string;
  tone: string;
}) {
  const items = [
    { label: 'Identidade configurada', done: true, extra: `${sdrName} · tom ${tone}` },
    { label: 'WhatsApp conectado', done: checks?.hasWhatsapp ?? false, extra: undefined },
    {
      label: 'Bling ERP sincronizado',
      done: checks?.hasBling ?? false,
      extra: checks?.hasBling ? `${checks.productCount} produtos` : undefined,
    },
    { label: 'Base de conhecimento ativa', done: checks?.hasKbSeeded ?? false, extra: undefined },
  ];
  const allEssentials = items.slice(0, 3).every((i) => i.done);

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-4">
        <DaniAvatar size="lg" />
        <div>
          <h3 className="text-lg font-bold" style={{ color: 'var(--text-1)' }}>
            Quase lá!
          </h3>
          <p className="text-sm mt-1" style={{ color: 'var(--text-2)' }}>
            Revise as configurações antes de ativar a Dani.
          </p>
        </div>
      </div>

      <div className="space-y-2">
        {items.map((item) => (
          <div
            key={item.label}
            className="flex items-center gap-3 p-3 rounded-md"
            style={{
              background: item.done ? 'var(--success-bg)' : 'var(--bg-subtle)',
              border: `1px solid ${item.done ? 'color-mix(in oklch, var(--success) 22%, transparent)' : 'var(--border)'}`,
            }}
          >
            <span
              className="w-6 h-6 rounded-full grid place-items-center"
              style={{
                background: item.done ? 'var(--success)' : 'var(--warning)',
                color: 'white',
              }}
            >
              {item.done ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                  <path d="M5 12l5 5L20 6" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 7v5l3 2" />
                </svg>
              )}
            </span>
            <span className="text-sm font-medium flex-1" style={{ color: 'var(--text-1)' }}>
              {item.label}
            </span>
            {item.extra && (
              <span className="text-xs" style={{ color: 'var(--text-3)' }}>
                {item.extra}
              </span>
            )}
          </div>
        ))}
      </div>

      {!allEssentials && (
        <div
          className="p-3 rounded-md text-sm"
          style={{
            background: 'var(--warning-bg)',
            color: 'var(--warning)',
            border: '1px solid color-mix(in oklch, var(--warning) 25%, transparent)',
          }}
        >
          ⚠️ Faltam itens essenciais. Você ainda pode ativar a Dani, mas algumas funcionalidades
          podem não funcionar até que tudo esteja conectado.
        </div>
      )}
    </div>
  );
}
