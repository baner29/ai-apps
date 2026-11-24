import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { cn } from '../../lib/cn';

const BASE_FIELD_CLASSES =
  'w-full rounded-lg bg-surface-0/90 border border-slate-700/80 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 ' +
  'transition-colors duration-150 hover:border-slate-600/90 ' +
  'focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/25 ' +
  'disabled:opacity-50 disabled:cursor-not-allowed';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, hint, error, id, className, ...rest }, ref) => {
    const autoId = useId();
    const fieldId = id ?? autoId;
    const descId = error || hint ? `${fieldId}-desc` : undefined;

    return (
      <div className="space-y-1.5">
        {label && (
          <label htmlFor={fieldId} className="block text-xs font-medium text-slate-300">
            {label}
          </label>
        )}
        <input
          ref={ref}
          id={fieldId}
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={descId}
          className={cn(
            BASE_FIELD_CLASSES,
            error && 'border-rose-500/80 focus:border-rose-500 focus:ring-rose-500/25',
            className
          )}
          {...rest}
        />
        {error ? (
          <p id={descId} className="text-xs text-rose-400">
            {error}
          </p>
        ) : hint ? (
          <p id={descId} className="text-xs text-slate-400">
            {hint}
          </p>
        ) : null}
      </div>
    );
  }
);
Input.displayName = 'Input';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  hint?: string;
  error?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ label, hint, error, id, className, rows = 4, ...rest }, ref) => {
    const autoId = useId();
    const fieldId = id ?? autoId;
    const descId = error || hint ? `${fieldId}-desc` : undefined;

    return (
      <div className="space-y-1.5">
        {label && (
          <label htmlFor={fieldId} className="block text-xs font-medium text-slate-300">
            {label}
          </label>
        )}
        <textarea
          ref={ref}
          id={fieldId}
          rows={rows}
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={descId}
          className={cn(
            BASE_FIELD_CLASSES,
            'resize-y custom-scrollbar',
            error && 'border-rose-500/80 focus:border-rose-500 focus:ring-rose-500/25',
            className
          )}
          {...rest}
        />
        {error ? (
          <p id={descId} className="text-xs text-rose-400">
            {error}
          </p>
        ) : hint ? (
          <p id={descId} className="text-xs text-slate-400">
            {hint}
          </p>
        ) : null}
      </div>
    );
  }
);
Textarea.displayName = 'Textarea';

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  hint?: string;
  error?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ label, hint, error, id, className, children, ...rest }, ref) => {
    const autoId = useId();
    const fieldId = id ?? autoId;
    const descId = error || hint ? `${fieldId}-desc` : undefined;

    return (
      <div className="space-y-1.5">
        {label && (
          <label htmlFor={fieldId} className="block text-xs font-medium text-slate-300">
            {label}
          </label>
        )}
        <select
          ref={ref}
          id={fieldId}
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={descId}
          className={cn(
            BASE_FIELD_CLASSES,
            'bg-surface-0',
            error && 'border-rose-500/80 focus:border-rose-500 focus:ring-rose-500/25',
            className
          )}
          {...rest}
        >
          {children}
        </select>
        {error ? (
          <p id={descId} className="text-xs text-rose-400">
            {error}
          </p>
        ) : hint ? (
          <p id={descId} className="text-xs text-slate-400">
            {hint}
          </p>
        ) : null}
      </div>
    );
  }
);
Select.displayName = 'Select';
