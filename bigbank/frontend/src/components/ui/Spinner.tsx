import { cn } from '../../lib/cn';

export interface SpinnerProps {
  size?: 'xs' | 'sm' | 'md' | 'lg';
  className?: string;
  label?: string;
}

const SIZE_CLASSES: Record<NonNullable<SpinnerProps['size']>, string> = {
  xs: 'h-3.5 w-3.5 border-[1.5px]',
  sm: 'h-4 w-4 border-2',
  md: 'h-5 w-5 border-2',
  lg: 'h-8 w-8 border-[2.5px]',
};

export function Spinner({ size = 'md', className, label = 'Loading' }: SpinnerProps) {
  return (
    <span
      role="status"
      aria-label={label}
      className={cn(
        'inline-block animate-spin rounded-full border-current border-t-transparent text-indigo-400',
        SIZE_CLASSES[size],
        className
      )}
    />
  );
}
