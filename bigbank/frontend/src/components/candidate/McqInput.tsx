import { Check } from 'lucide-react';
import { cn } from '../../lib/cn';

export interface McqInputProps {
  questionId: number;
  options: string[];
  multiSelect: boolean;
  value: number[];
  onChange: (indices: number[]) => void;
  disabled?: boolean;
}

const OPTION_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function McqInput({
  questionId,
  options,
  multiSelect,
  value,
  onChange,
  disabled = false,
}: McqInputProps) {
  const selectedSet = new Set(value);

  const handleToggle = (index: number) => {
    if (disabled) return;
    if (multiSelect) {
      const next = new Set(selectedSet);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      onChange(Array.from(next).sort((a, b) => a - b));
    } else {
      onChange([index]);
    }
  };

  return (
    <fieldset disabled={disabled} className="space-y-3">
      <legend className="flex items-center justify-between w-full text-xs font-medium text-slate-400 pb-1">
        <span>{multiSelect ? 'Select all options that apply' : 'Select the best answer'}</span>
        {selectedSet.size > 0 && (
          <span className="text-indigo-300">
            {selectedSet.size} {selectedSet.size === 1 ? 'option' : 'options'} selected
          </span>
        )}
      </legend>

      <div className="space-y-2.5" role={multiSelect ? 'group' : 'radiogroup'}>
        {options.map((optionText, idx) => {
          const isSelected = selectedSet.has(idx);
          const letter = OPTION_LETTERS[idx] ?? String(idx + 1);
          const inputId = `mcq-${questionId}-opt-${idx}`;

          return (
            <label
              key={idx}
              htmlFor={inputId}
              className={cn(
                'group relative flex cursor-pointer items-start gap-3.5 rounded-xl border p-4 transition-all duration-150',
                'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-indigo-400/80 has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-surface-0',
                isSelected
                  ? 'border-indigo-500/80 bg-indigo-500/12 shadow-glow-indigo'
                  : 'border-slate-800/90 bg-surface-0/70 hover:border-slate-700 hover:bg-surface-2/60',
                disabled && 'cursor-not-allowed opacity-60'
              )}
            >
              <input
                id={inputId}
                type={multiSelect ? 'checkbox' : 'radio'}
                name={`mcq-question-${questionId}`}
                value={idx}
                checked={isSelected}
                onChange={() => handleToggle(idx)}
                disabled={disabled}
                className="sr-only"
              />

              {/* Visual Radio / Checkbox Indicator */}
              <span
                aria-hidden="true"
                className={cn(
                  'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center border transition-colors',
                  multiSelect ? 'rounded-md' : 'rounded-full',
                  isSelected
                    ? 'border-indigo-400 bg-indigo-500 text-white'
                    : 'border-slate-600 bg-surface-1 group-hover:border-slate-500'
                )}
              >
                {isSelected &&
                  (multiSelect ? (
                    <Check className="h-3.5 w-3.5 stroke-[3]" />
                  ) : (
                    <span className="h-2 w-2 rounded-full bg-white" />
                  ))}
              </span>

              {/* Letter Pill */}
              <span
                aria-hidden="true"
                className={cn(
                  'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md font-mono text-xs font-semibold transition-colors',
                  isSelected
                    ? 'bg-indigo-500/25 text-indigo-200 border border-indigo-400/40'
                    : 'bg-slate-800/90 text-slate-400 border border-slate-700/70 group-hover:text-slate-200'
                )}
              >
                {letter}
              </span>

              {/* Option Content */}
              <span
                className={cn(
                  'min-w-0 flex-1 text-sm leading-relaxed whitespace-pre-wrap',
                  isSelected ? 'text-white font-medium' : 'text-slate-200'
                )}
              >
                {optionText}
              </span>
            </label>
          );
        })}
      </div>

      {options.length === 0 && (
        <p className="rounded-xl border border-slate-800 bg-surface-0/60 p-4 text-xs text-slate-400">
          No options configured for this question.
        </p>
      )}
    </fieldset>
  );
}
