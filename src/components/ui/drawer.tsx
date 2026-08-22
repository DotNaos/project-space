import {
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@dotnaos/ui/base';

export interface DrawerProps {
  children: ReactNode;
  closeLabel: string;
  dismissible?: boolean;
  label: string;
  onClose(): void;
  open: boolean;
  width?: 'compact' | 'medium' | 'wide';
}

export interface DrawerRegionProps {
  children: ReactNode;
}

const widthClasses: Record<NonNullable<DrawerProps['width']>, string> = {
  compact: 'sm:max-w-sm',
  medium: 'sm:max-w-lg',
  wide: 'sm:max-w-2xl',
};

function DrawerRoot({
  children,
  closeLabel,
  dismissible = true,
  label,
  onClose,
  open,
  width = 'medium',
}: DrawerProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open) {
      restoreFocusRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
      if (!dialog.open) dialog.showModal();
      const previousOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      const frame = requestAnimationFrame(() => setEntered(true));
      return () => {
        cancelAnimationFrame(frame);
        document.body.style.overflow = previousOverflow;
      };
    }

    setEntered(false);
    const timeout = window.setTimeout(() => {
      if (dialog.open) dialog.close();
      restoreFocusRef.current?.focus();
    }, 200);
    return () => window.clearTimeout(timeout);
  }, [open]);

  useEffect(() => () => {
    const dialog = dialogRef.current;
    if (dialog?.open) dialog.close();
    const restoreFocus = restoreFocusRef.current;
    requestAnimationFrame(() => restoreFocus?.focus());
  }, []);

  useEffect(() => {
    if (!open || !dismissible) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    }
    document.addEventListener('keydown', closeOnEscape, true);
    return () => document.removeEventListener('keydown', closeOnEscape, true);
  }, [dismissible, onClose, open]);

  function dismiss(event: MouseEvent<HTMLDivElement>) {
    if (dismissible && event.target === event.currentTarget) onClose();
  }

  if (typeof document === 'undefined') return null;
  const activeTheme = document.activeElement instanceof HTMLElement
    ? document.activeElement.closest<HTMLElement>('[data-theme]')?.dataset.theme
    : undefined;
  const theme = activeTheme ?? document.documentElement.dataset.theme;

  return createPortal(
    <dialog
      aria-label={label}
      aria-modal="true"
      className="fixed inset-0 m-0 h-dvh w-screen max-w-none overflow-hidden bg-transparent p-0 text-text outline-none backdrop:bg-transparent"
      data-theme={theme}
      data-ui-component="Drawer"
      onCancel={(event) => {
        event.preventDefault();
        if (dismissible) onClose();
      }}
      ref={dialogRef}
    >
      <div
        className={`flex h-full w-full justify-end bg-overlay transition-opacity duration-200 ${entered ? 'opacity-100' : 'opacity-0'}`}
        onMouseDown={dismiss}
      >
        <section
          className={`grid h-full w-full grid-rows-[auto_minmax(0,1fr)_auto] border-l border-border bg-bg-0 shadow-lg transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] ${widthClasses[width]} ${entered ? 'translate-x-0' : 'translate-x-full'}`}
          role="document"
        >
          <div className="absolute right-3 top-3 z-10">
            <Button
              accessibilityLabel={closeLabel}
              disabled={!dismissible}
              icon="close"
              onPress={onClose}
              variant="icon"
            />
          </div>
          {children}
        </section>
      </div>
    </dialog>,
    document.body,
  );
}

function DrawerHeader({ children }: DrawerRegionProps) {
  return <header className="border-b border-border px-5 py-5 pr-14 sm:px-6 sm:py-6 sm:pr-16">{children}</header>;
}

function DrawerBody({ children }: DrawerRegionProps) {
  return <div className="min-h-0 overflow-y-auto px-5 py-5 sm:px-6">{children}</div>;
}

function DrawerFooter({ children }: DrawerRegionProps) {
  return <footer className="border-t border-border px-5 py-4 sm:px-6">{children}</footer>;
}

export const Drawer = Object.assign(DrawerRoot, {
  Body: DrawerBody,
  Footer: DrawerFooter,
  Header: DrawerHeader,
});
