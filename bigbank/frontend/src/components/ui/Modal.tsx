import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '../../lib/cn';

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl' | '2xl';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  size?: ModalSize;
  /** Whether clicking outside the dialog or pressing Escape dismisses it. Defaults to true. */
  dismissible?: boolean;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}

const SIZE_CLASSES: Record<ModalSize, string> = {
  sm: 'w-full max-w-md',
  md: 'w-full max-w-lg',
  lg: 'w-full max-w-2xl',
  xl: 'w-full max-w-4xl',
  '2xl': 'w-full max-w-5xl',
};

function isPointerOutside(event: PointerEvent, dialog: HTMLDialogElement): boolean {
  const rect = dialog.getBoundingClientRect();
  return (
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom
  );
}

export function Modal({
  open,
  onClose,
  title,
  description,
  size = 'md',
  dismissible = true,
  footer,
  children,
  className,
}: ModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open) {
      if (!dialog.open) {
        dialog.showModal();
      }
    } else if (dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const handleClose = () => {
      dialog.returnValue = '';
      if (open) {
        onClose();
      }
    };

    const handleCancel = (event: Event) => {
      if (!dismissible) {
        event.preventDefault();
      }
    };

    dialog.addEventListener('close', handleClose);
    dialog.addEventListener('cancel', handleCancel);

    // Light-dismiss fallback for browsers without native HTMLDialogElement.prototype.closedBy
    let cleanupPointer: (() => void) | undefined;
    if (dismissible && typeof HTMLDialogElement !== 'undefined' && !('closedBy' in HTMLDialogElement.prototype)) {
      let pressedOutside = false;
      const onPointerDown = (event: PointerEvent) => {
        pressedOutside = isPointerOutside(event, dialog);
      };
      const onPointerUp = (event: PointerEvent) => {
        if (pressedOutside && isPointerOutside(event, dialog)) {
          dialog.close();
        }
        pressedOutside = false;
      };
      dialog.addEventListener('pointerdown', onPointerDown);
      dialog.addEventListener('pointerup', onPointerUp);
      cleanupPointer = () => {
        dialog.removeEventListener('pointerdown', onPointerDown);
        dialog.removeEventListener('pointerup', onPointerUp);
      };
    }

    return () => {
      dialog.removeEventListener('close', handleClose);
      dialog.removeEventListener('cancel', handleCancel);
      cleanupPointer?.();
    };
  }, [open, onClose, dismissible]);

  const closedByAttr = { closedby: dismissible ? 'any' : 'none' } as Record<string, string>;

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={title ? titleId : undefined}
      aria-label={!title ? 'Dialog' : undefined}
      {...closedByAttr}
      className={cn(SIZE_CLASSES[size], 'animate-slide-up', className)}
    >
      <div className="flex max-h-[calc(100dvh-2rem)] w-full flex-col overflow-hidden rounded-2xl bg-surface-1 border border-slate-700/80 shadow-2xl shadow-black/70">
        {(title || dismissible) && (
          <div className="flex items-start justify-between gap-4 px-6 py-4 border-b border-slate-800/90">
            <div className="min-w-0">
              {title && (
                <h1 id={titleId} className="text-base font-semibold tracking-tight text-slate-100">
                  {title}
                </h1>
              )}
              {description && <p className="mt-1 text-xs text-slate-400">{description}</p>}
            </div>
            {dismissible && (
              <button
                type="button"
                onClick={() => dialogRef.current?.close()}
                aria-label="Close dialog"
                className="shrink-0 rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-100 transition-colors focus-ring"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-6 py-5 custom-scrollbar">{children}</div>

        {footer && (
          <div className="flex items-center justify-end gap-2.5 px-6 py-4 border-t border-slate-800/90 bg-surface-0/50">
            {footer}
          </div>
        )}
      </div>
    </dialog>
  );
}
