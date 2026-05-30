import { useState } from 'react';
import { cn } from '@/lib/utils';

interface AvatarProps {
  src?: string | null;
  alt?: string;
  fallback: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
  status?: 'online' | 'offline' | 'busy' | null;
}

const sizeMap = {
  sm: 'h-7 w-7 text-[10px]',
  md: 'h-9 w-9 text-xs',
  lg: 'h-12 w-12 text-sm',
  xl: 'h-16 w-16 text-base',
};

const dotSize = { sm: 'h-2 w-2', md: 'h-2.5 w-2.5', lg: 'h-3 w-3', xl: 'h-3.5 w-3.5' };

// Cor estável baseada em hash do nome
function colorFromName(name: string): string {
  const hash = name.split('').reduce((acc, c) => (acc * 31 + c.charCodeAt(0)) | 0, 0);
  const palette = [
    'from-pink-500/25 to-pink-700/15 text-pink-200',
    'from-blue-500/25 to-blue-700/15 text-blue-200',
    'from-green-500/25 to-green-700/15 text-green-200',
    'from-purple-500/25 to-purple-700/15 text-purple-200',
    'from-orange-500/25 to-orange-700/15 text-orange-200',
    'from-cyan-500/25 to-cyan-700/15 text-cyan-200',
    'from-rose-500/25 to-rose-700/15 text-rose-200',
    'from-amber-500/25 to-amber-700/15 text-amber-200',
  ];
  return palette[Math.abs(hash) % palette.length];
}

export function Avatar({ src, alt, fallback, size = 'md', className, status }: AvatarProps) {
  const [imgError, setImgError] = useState(false);
  const initials = fallback
    .trim()
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase() || '?';

  const showImg = src && !imgError;
  const colorCls = showImg ? 'bg-secondary' : `bg-gradient-to-br ${colorFromName(fallback)}`;
  const statusColor =
    status === 'online' ? 'bg-fce-green' : status === 'busy' ? 'bg-yellow-500' : 'bg-muted-foreground';

  return (
    <div
      className={cn(
        'relative inline-flex items-center justify-center rounded-full font-semibold overflow-hidden shrink-0',
        colorCls,
        sizeMap[size],
        className,
      )}
    >
      {showImg ? (
        <img
          src={src!}
          alt={alt || fallback}
          className="h-full w-full object-cover"
          onError={() => setImgError(true)}
        />
      ) : (
        <span>{initials}</span>
      )}
      {status && (
        <span
          className={cn(
            'absolute bottom-0 right-0 rounded-full border-2 border-background',
            statusColor,
            dotSize[size],
          )}
        />
      )}
    </div>
  );
}
