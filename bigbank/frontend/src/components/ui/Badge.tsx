import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

export type BadgeVariant =
  | 'default'
  | 'indigo'
  | 'cyan'
  | 'emerald'
  | 'amber'
  | 'rose'
  | 'slate';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  size?: 'sm' | 'md';
  dot?: boolean;
}

const VARIANT_CLASSES: Record<BadgeVariant, string> = {
  default: 'bg-slate-800/90 text-slate-200 border-slate-700/80',
  slate: 'bg-slate-800/70 text-slate-300 border-slate-700/70',
  indigo: 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30',
  cyan: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30',
  emerald: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  amber: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  rose: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
};

const DOT_CLASSES: Record<BadgeVariant, string> = {
  default: 'bg-slate-400',
  slate: 'bg-slate-400',
  indigo: 'bg-indigo-400',
  cyan: 'bg-cyan-400',
  emerald: 'bg-emerald-400',
  amber: 'bg-amber-400',
  rose: 'bg-rose-400',
};

export function Badge({
  variant = 'default',
  size = 'sm',
  dot = false,
  className,
  children,
  ...rest
}: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border font-medium whitespace-nowrap',
        size === 'sm' ? 'px-2 py-0.5 text-[11px] leading-4' : 'px-2.5 py-0.5 text-xs leading-5',
        VARIANT_CLASSES[variant],
        className
      )}
      {...rest}
    >
      {dot && <span className={cn('h-1.5 w-1.5 rounded-full shrink-0', DOT_CLASSES[variant])} />}
      {children}
    </span>
  );
}
