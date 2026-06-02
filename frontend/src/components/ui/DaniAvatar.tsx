import { cn } from '@/lib/utils';

interface DaniAvatarProps {
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Quando false, esconde o spark (humano assumiu) */
  active?: boolean;
  className?: string;
}

/**
 * Avatar da DANI: gradiente violeta com "spark" (estrela) no canto.
 * Sinaliza geração automática. Tema constante, independe de direção.
 */
export function DaniAvatar({ size = 'md', active = true, className }: DaniAvatarProps) {
  const sizeClass =
    size === 'sm' ? 'w-7 h-7 text-[11px]' :
    size === 'lg' ? 'dani-av lg' :
    size === 'xl' ? 'dani-av xl' :
    '';

  return (
    <div className={cn('dani-av', sizeClass, className)}>
      D
      {active && (
        <span className="spark">
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2l1.6 5.4L19 9l-5.4 1.6L12 16l-1.6-5.4L5 9l5.4-1.6z" />
          </svg>
        </span>
      )}
    </div>
  );
}
