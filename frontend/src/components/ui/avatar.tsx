import { useState, type ImgHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

interface AvatarProps {
  src?: string | null;
  alt?: string;
  fallback: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const sizeMap = {
  sm: 'h-8 w-8 text-xs',
  md: 'h-10 w-10 text-sm',
  lg: 'h-12 w-12 text-base',
};

export function Avatar({ src, alt, fallback, size = 'md', className }: AvatarProps) {
  const [imgError, setImgError] = useState(false);
  const initials = fallback
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <div
      className={cn(
        'relative inline-flex items-center justify-center rounded-full bg-secondary font-semibold text-foreground overflow-hidden shrink-0',
        sizeMap[size],
        className,
      )}
    >
      {src && !imgError ? (
        <img
          src={src}
          alt={alt || fallback}
          className="h-full w-full object-cover"
          onError={() => setImgError(true)}
        />
      ) : (
        <span>{initials}</span>
      )}
    </div>
  );
}
