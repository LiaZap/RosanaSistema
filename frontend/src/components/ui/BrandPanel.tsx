import { DaniAvatar } from './DaniAvatar';

interface BrandPanelProps {
  kicker?: string;
}

/**
 * Painel direito split-screen do auth.
 * Gradiente da primária + 2 radiais decorativos + chat mock.
 * Esconde abaixo de 880px (`.brand-side`).
 */
export function BrandPanel({ kicker = 'SDR com IA · WhatsApp' }: BrandPanelProps) {
  return (
    <div
      className="brand-side hidden lg:flex flex-1 relative overflow-hidden text-white"
      style={{ background: 'linear-gradient(160deg, var(--primary), var(--primary-press))' }}
    >
      {/* Radiais decorativos */}
      <div
        className="absolute inset-0 opacity-55"
        style={{
          background:
            'radial-gradient(110% 70% at 100% 0%, color-mix(in oklch, var(--accent) 60%, transparent), transparent 58%)',
        }}
      />
      <div
        className="absolute inset-0 opacity-40"
        style={{
          background:
            'radial-gradient(80% 60% at 0% 100%, color-mix(in oklch, var(--primary) 60%, black 30%), transparent 60%)',
        }}
      />

      {/* Logo - topo fixo */}
      <div className="absolute top-10 left-13 right-13 flex items-center gap-3" style={{ left: 52, right: 52 }}>
        <div
          className="w-11 h-11 rounded-md grid place-items-center font-extrabold text-xl"
          style={{
            background: 'rgba(255,255,255,.16)',
            border: '1px solid rgba(255,255,255,.25)',
            letterSpacing: '-0.04em',
          }}
        >
          F
        </div>
        <div>
          <div className="font-bold text-[15.5px] whitespace-nowrap">Filhos com Estilo</div>
          <div className="text-xs opacity-80">Studio · SDR com IA</div>
        </div>
      </div>

      {/* Centro: kicker + headline + chat mock */}
      <div
        className="absolute inset-0 flex flex-col justify-center"
        style={{ padding: '0 52px' }}
      >
        <div
          className="text-xs font-semibold uppercase opacity-80 mb-3 font-mono"
          style={{ letterSpacing: '.14em' }}
        >
          {kicker}
        </div>
        <h2
          className="m-0 mb-6 font-extrabold leading-tight"
          style={{ fontSize: 31, letterSpacing: '-0.03em', maxWidth: '16ch' }}
        >
          A Dani atende, qualifica e vende.
        </h2>

        {/* PanelChatCard */}
        <div
          className="relative rounded-xl p-[18px]"
          style={{
            background: 'rgba(255,255,255,.13)',
            border: '1px solid rgba(255,255,255,.22)',
            boxShadow: '0 30px 60px rgba(0,0,0,.28)',
            borderRadius: 'var(--r-xl)',
          }}
        >
          {/* Header */}
          <div
            className="flex items-center gap-3 pb-3.5 border-b"
            style={{ borderColor: 'rgba(255,255,255,.16)' }}
          >
            <DaniAvatar size="md" />
            <div className="flex-1 min-w-0">
              <div className="font-bold text-sm">Dani</div>
              <div className="text-[11.5px] opacity-80 flex items-center gap-1.5">
                <span
                  className="w-[7px] h-[7px] rounded-full"
                  style={{
                    background: '#7CF2B0',
                    boxShadow: '0 0 0 3px rgba(124,242,176,.25)',
                  }}
                />
                respondendo em 8s
              </div>
            </div>
            <span
              className="font-mono text-[10.5px] font-semibold uppercase px-2.5 py-1 rounded-full"
              style={{ background: 'rgba(255,255,255,.16)', letterSpacing: '.06em' }}
            >
              WHATSAPP
            </span>
          </div>

          {/* Bolhas */}
          <div className="flex flex-col gap-2.5 pt-3.5">
            <div
              className="self-end max-w-[82%] py-2 px-3 text-[13px] leading-[1.45]"
              style={{
                background: 'rgba(255,255,255,.22)',
                borderRadius: '13px 4px 13px 13px',
              }}
            >
              oi, tem o macacão da baleia tam M? 🐳
            </div>
            <div
              className="self-start max-w-[88%] py-2 px-3 text-[13px] leading-[1.45] font-medium"
              style={{
                background: '#fff',
                color: 'var(--primary-press)',
                borderRadius: '4px 13px 13px 13px',
              }}
            >
              Tenho sim! O Macacão Azul Baleia Up Baby (M) está disponível por R$ 69,90 — tecido
              super macio. Quer que eu já separe e feche o pedido? 😊
            </div>

            {/* Product mini-card */}
            <div
              className="self-start max-w-[88%] flex items-center gap-2.5 p-2.5"
              style={{
                background: '#fff',
                color: 'var(--primary-press)',
                borderRadius: 12,
              }}
            >
              <div
                className="w-10 h-10 rounded-lg grid place-items-center flex-none"
                style={{ background: 'color-mix(in oklch, var(--primary) 14%, white)' }}
              >
                <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                  <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[12.5px] font-bold whitespace-nowrap">
                  Macacão Azul Baleia · M
                </div>
                <div className="font-mono text-[10.5px] opacity-65">
                  MAC-AZ-014 · 14 em estoque
                </div>
              </div>
              <div className="text-sm font-extrabold flex-none">R$ 69,90</div>
            </div>

            {/* Typing */}
            <div
              className="self-end flex items-center gap-1.5 py-2 px-3"
              style={{ background: 'rgba(255,255,255,.16)', borderRadius: 999 }}
            >
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="w-[6px] h-[6px] rounded-full"
                  style={{
                    background: '#fff',
                    opacity: 0.9,
                    animation: `fceDot 1.2s ${i * 0.18}s infinite ease-in-out`,
                  }}
                />
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Stats - rodapé fixo */}
      <div className="absolute bottom-10 flex gap-7" style={{ left: 52, right: 52 }}>
        {[
          ['90%', 'resolvido sem humano'],
          ['8s', '1ª resposta'],
          ['4.959', 'produtos no Bling'],
        ].map(([v, l]) => (
          <div key={l}>
            <div
              className="text-[22px] font-extrabold"
              style={{
                letterSpacing: '-0.02em',
                fontFeatureSettings: '"tnum" 1',
              }}
            >
              {v}
            </div>
            <div className="text-[11.5px] opacity-80 mt-0.5">{l}</div>
          </div>
        ))}
      </div>

      {/* Keyframe pra animação do typing (inline pra independência) */}
      <style>
        {`@keyframes fceDot { 0%, 60%, 100% { opacity: .3; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-3px); } }`}
      </style>
    </div>
  );
}
