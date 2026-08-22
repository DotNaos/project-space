import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type ForwardedRef
} from 'react';
import { WTerm } from '@wterm/dom';
import '@wterm/dom/css';

export interface TerminalHandle {
  focus(): void;
  reset(): void;
  write(data: string | Uint8Array): void;
}

export interface TerminalProps {
  accessibilityLabel: string;
  autoFocus?: boolean;
  className?: string;
  cols?: number;
  onData?(data: string): void;
  onError?(error: Error): void;
  onReady?(): void;
  onResize?(cols: number, rows: number): void;
  rows?: number;
}

const terminalTheme = [
  'dotnaos-terminal h-full min-h-0 w-full',
  '[--term-bg:var(--color-bg-0)] [--term-fg:var(--color-text)]',
  '[--term-cursor:var(--color-text)] [--term-color-0:var(--color-bg-0)]',
  '[--term-color-1:var(--color-danger)] [--term-color-2:var(--color-success)]',
  '[--term-color-3:var(--color-warning)] [--term-color-4:var(--color-accent)]',
  '[--term-color-7:var(--color-text)] [--term-color-8:var(--color-text-muted)]',
  '!rounded-none !bg-bg-0 !p-4 !shadow-none'
].join(' ');

function TerminalComponent({
  accessibilityLabel,
  autoFocus = false,
  className,
  cols = 100,
  onData,
  onError,
  onReady,
  onResize,
  rows = 28
}: TerminalProps, forwardedRef: ForwardedRef<TerminalHandle>) {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<WTerm | null>(null);
  const onDataRef = useRef(onData);
  const onErrorRef = useRef(onError);
  const onReadyRef = useRef(onReady);
  const onResizeRef = useRef(onResize);

  onDataRef.current = onData;
  onErrorRef.current = onError;
  onReadyRef.current = onReady;
  onResizeRef.current = onResize;

  useImperativeHandle(forwardedRef, () => ({
    focus() {
      terminalRef.current?.focus();
    },
    reset() {
      terminalRef.current?.write('\x1bc');
    },
    write(data) {
      terminalRef.current?.write(data);
    }
  }), []);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;

    let cancelled = false;
    const terminal = new WTerm(element, {
      autoResize: true,
      cols,
      cursorBlink: true,
      onData(data) {
        onDataRef.current?.(data);
      },
      onResize(nextCols, nextRows) {
        onResizeRef.current?.(nextCols, nextRows);
      },
      rows
    });
    terminalRef.current = terminal;

    terminal.init().then(() => {
      if (cancelled) return;
      onReadyRef.current?.();
      if (autoFocus) terminal.focus();
    }).catch((error: unknown) => {
      if (!cancelled) {
        onErrorRef.current?.(
          error instanceof Error ? error : new Error('The terminal could not start.')
        );
      }
    });

    return () => {
      cancelled = true;
      terminal.destroy();
      if (terminalRef.current === terminal) terminalRef.current = null;
    };
  }, [autoFocus, cols, rows]);

  return (
    <div
      ref={elementRef}
      aria-label={accessibilityLabel}
      className={`${terminalTheme}${className ? ` ${className}` : ''}`}
      role="application"
    />
  );
}

/**
 * Transport-neutral wterm boundary intended for promotion through DotNaos/ui#87.
 * Applications own connection authorization, networking, and session state.
 */
export const Terminal = forwardRef(TerminalComponent);
