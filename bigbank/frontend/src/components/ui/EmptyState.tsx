import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-800 bg-surface-1/50 px-6 py-12 text-center',
        className
      )}
    >
      {icon && (
        <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-slate-800/80 text-indigo-400 border border-slate-700/70">
          {icon}
        </div>
      )}
      <h3 className="text-sm font-semibold text-slate-100">{title}</h3>
      {description && <p className="mt-1 max-w-md text-xs text-slate-400">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
