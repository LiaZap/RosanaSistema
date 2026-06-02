import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { BrandPanel } from '../components/ui/BrandPanel';
import { ThemeToggle } from '../components/ui/ThemeControls';

// Ícones inline (matching design)
const ICONS = {
  mail: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 7l9 6 9-6" />
    </svg>
  ),
  lock: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  ),
  user: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  ),
  eye: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ),
  eyeOff: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-10-7-10-7a18.6 18.6 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 10 7 10 7a18.5 18.5 0 0 1-2.16 3.19M14.12 14.12a3 3 0 1 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  ),
};

interface AuthInputProps {
  icon: keyof typeof ICONS;
  type?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  reveal?: boolean;
  required?: boolean;
  autoComplete?: string;
}

/** Input com ícone à esquerda + estado focus com anel primary */
function AuthInput({ icon, type, value, onChange, placeholder, reveal, required, autoComplete }: AuthInputProps) {
  const [show, setShow] = useState(false);
  const [foc, setFoc] = useState(false);
  const t = reveal ? (show ? 'text' : 'password') : type ?? 'text';

  return (
    <div
      className="flex items-center gap-2.5 px-3 h-[46px] rounded-md transition-all"
      style={{
        background: 'var(--bg-app)',
        border: `1px solid ${foc ? 'var(--primary)' : 'var(--border-strong)'}`,
        boxShadow: foc ? 'var(--sh-focus)' : 'none',
      }}
    >
      <span
        className="flex-none transition-colors"
        style={{ color: foc ? 'var(--primary)' : 'var(--text-3)' }}
      >
        {ICONS[icon]}
      </span>
      <input
        type={t}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFoc(true)}
        onBlur={() => setFoc(false)}
        required={required}
        autoComplete={autoComplete}
        className="flex-1 border-0 outline-0 bg-transparent text-sm"
        style={{ color: 'var(--text-1)' }}
      />
      {reveal && (
        <button
          type="button"
          aria-label="Mostrar senha"
          onClick={() => setShow((s) => !s)}
          className="grid place-items-center p-0.5"
          style={{ color: 'var(--text-3)' }}
        >
          {show ? ICONS.eyeOff : ICONS.eye}
        </button>
      )}
    </div>
  );
}

export default function AuthPage() {
  const navigate = useNavigate();
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      if (isLogin) {
        await api.post('/auth/login', { email, password });
      } else {
        await api.post('/auth/signup', { email, password, fullName: fullName || undefined });
      }
      navigate('/dashboard');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Erro de conexão. Tente novamente.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex h-screen" style={{ background: 'var(--bg-app)' }}>
      {/* Lado do formulário */}
      <div className="flex-1 relative flex items-center justify-center p-8 overflow-y-auto">
        <div className="absolute top-6 right-6">
          <ThemeToggle />
        </div>

        <div className="w-full max-w-sm">
          {/* Logo + tagline */}
          <div className="flex items-center gap-3 mb-7">
            <div
              className="w-[38px] h-[38px] rounded-md grid place-items-center font-extrabold text-lg"
              style={{
                background: 'linear-gradient(150deg, var(--primary), var(--primary-press))',
                color: 'var(--text-on-primary)',
              }}
            >
              F
            </div>
            <span className="font-bold text-[15px] whitespace-nowrap" style={{ color: 'var(--text-1)' }}>
              Filhos com Estilo
            </span>
          </div>

          <h1
            className="m-0 mb-2"
            style={{
              fontSize: 27,
              fontWeight: 700,
              letterSpacing: '-0.02em',
              color: 'var(--text-1)',
            }}
          >
            {isLogin ? 'Entrar no Studio' : 'Criar conta'}
          </h1>
          <p className="m-0 mb-7 text-[14.5px]" style={{ color: 'var(--text-2)' }}>
            {isLogin
              ? 'Acesse o painel de atendimento da Dani.'
              : 'Configure seu workspace em poucos minutos.'}
          </p>

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            {!isLogin && (
              <div>
                <label className="field-label">Nome completo</label>
                <AuthInput
                  icon="user"
                  type="text"
                  value={fullName}
                  onChange={setFullName}
                  placeholder="Seu nome"
                  autoComplete="name"
                />
              </div>
            )}

            <div>
              <label className="field-label">E-mail</label>
              <AuthInput
                icon="mail"
                type="email"
                value={email}
                onChange={setEmail}
                placeholder="equipe@filhoscomestilo.com.br"
                required
                autoComplete="email"
              />
            </div>

            <div>
              <label className="field-label">Senha</label>
              <AuthInput
                icon="lock"
                value={password}
                onChange={setPassword}
                placeholder={isLogin ? '••••••••' : 'Mínimo 8 caracteres'}
                reveal
                required
                autoComplete={isLogin ? 'current-password' : 'new-password'}
              />
            </div>

            {error && (
              <div
                className="text-sm rounded-md px-3 py-2"
                style={{
                  background: 'var(--danger-bg)',
                  color: 'var(--danger)',
                  border: '1px solid color-mix(in oklch, var(--danger) 25%, transparent)',
                }}
              >
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="btn btn-primary w-full justify-center mt-2"
              style={{ padding: '12px 18px', fontSize: '14.5px' }}
            >
              {loading ? 'Aguarde...' : isLogin ? 'Entrar no Studio →' : 'Criar conta →'}
            </button>
          </form>

          {/* Toggle */}
          <p className="text-center text-sm mt-6" style={{ color: 'var(--text-2)' }}>
            {isLogin ? 'Não tem conta?' : 'Já tem conta?'}{' '}
            <button
              type="button"
              onClick={() => {
                setIsLogin(!isLogin);
                setError('');
              }}
              className="font-semibold underline-offset-2 hover:underline"
              style={{ color: 'var(--primary-text)' }}
            >
              {isLogin ? 'Criar conta' : 'Fazer login'}
            </button>
          </p>
        </div>
      </div>

      {/* Painel direito */}
      <BrandPanel kicker={isLogin ? 'Bem-vindo de volta' : 'Crie seu workspace'} />
    </div>
  );
}
