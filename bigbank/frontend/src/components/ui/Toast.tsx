import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { cn } from '../../lib/cn';

export type ToastVariant = 'info' | 'success' | 'warning' | 'error';

export interface ToastInput {
  title: string;
  description?: string;
  variant?: ToastVariant;
  durationMs?: number;
}

interface ToastItem extends Required<Pick<ToastInput, 'title' | 'variant'>> {
  id: string;
  description?: string;
}

interface ToastContextValue {
  toast: (input: ToastInput) => void;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const VARIANT_CLASSES: Record<ToastVariant, string> = {
  info: 'border-cyan-500/35 bg-surface-1/95 text-slate-100',
  success: 'border-emerald-500/35 bg-surface-1/95 text-slate-100',
  warning: 'border-amber-500/35 bg-surface-1/95 text-slate-100',
  error: 'border-rose-500/40 bg-surface-1/95 text-slate-100',
};

const ICON_COLORS: Record<ToastVariant, string> = {
  info: 'text-cyan-400',
  success: 'text-emerald-400',
  warning: 'text-amber-400',
  error: 'text-rose-400',
};

const ICON_MAP: Record<ToastVariant, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: AlertCircle,
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: string) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const toast = useCallback(
    ({ title, description, variant = 'info', durationMs = 4500 }: ToastInput) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setItems((prev) => [...prev.slice(-4), { id, title, description, variant }]);
      if (durationMs > 0) {
        window.setTimeout(() => {
          dismiss(id);
        }, durationMs);
      }
    },
    [dismiss]
  );

  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        aria-label="Notifications"
        className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-full max-w-sm flex-col gap-2"
      >
        {items.map((item) => {
          const Icon = ICON_MAP[item.variant];
          return (
            <div
              key={item.id}
              role={item.variant === 'error' ? 'alert' : 'status'}
              className={cn(
                'pointer-events-auto flex items-start gap-3 rounded-xl border px-4 py-3 shadow-xl shadow-black/50 backdrop-blur-md animate-slide-up',
                VARIANT_CLASSES[item.variant]
              )}
            >
              <Icon className={cn('h-4 w-4 mt-0.5 shrink-0', ICON_COLORS[item.variant])} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium leading-5 text-slate-100">{item.title}</p>
                {item.description && (
                  <p className="mt-0.5 text-xs leading-4 text-slate-400">{item.description}</p>
                )}
              </div>
              <button
                type="button"
                onClick={() => dismiss(item.id)}
                aria-label="Dismiss notification"
                className="shrink-0 rounded-md p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100 focus-ring"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return ctx;
}
