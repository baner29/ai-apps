import type { HTMLAttributes, ReactNode } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { cn } from '../../lib/cn';

export type AlertVariant = 'info' | 'success' | 'warning' | 'error';

export interface AlertProps extends HTMLAttributes<HTMLDivElement> {
  variant?: AlertVariant;
  title?: string;
  onDismiss?: () => void;
  action?: ReactNode;
}

const VARIANT_STYLES: Record<AlertVariant, string> = {
  info: 'bg-cyan-500/10 border-cyan-500/30 text-cyan-200',
  success: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200',
  warning: 'bg-amber-500/10 border-amber-500/30 text-amber-200',
  error: 'bg-rose-500/10 border-rose-500/30 text-rose-200',
};

const ICON_MAP: Record<AlertVariant, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: AlertCircle,
};

export function Alert({
  variant = 'info',
  title,
  onDismiss,
  action,
  className,
  children,
  ...rest
}: AlertProps) {
  const Icon = ICON_MAP[variant];

  return (
    <div
      role={variant === 'error' || variant === 'warning' ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-3 rounded-xl border px-4 py-3 text-sm',
        VARIANT_STYLES[variant],
        className
      )}
      {...rest}
    >
      <Icon className="h-4 w-4 mt-0.5 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-0.5">
        {title && <p className="font-semibold leading-5">{title}</p>}
        {children && <div className="text-xs leading-5 opacity-90">{children}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss message"
          className="shrink-0 rounded-md p-1 opacity-70 hover:opacity-100 focus-ring"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
