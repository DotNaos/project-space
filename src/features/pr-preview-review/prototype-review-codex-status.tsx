import {
  CircleAlert,
  Loader2,
  Maximize2,
  MessageSquarePlus,
  RefreshCw
} from 'lucide-react';

import type { PrototypeTheme } from '@/shared/prototype-canvas';

export function PrototypeReviewCodexStatus({
  isConnecting,
  message,
  onRetry,
  theme
}: {
  isConnecting: boolean;
  message: string;
  onRetry(): void;
  theme: PrototypeTheme;
}) {
  const isDark = theme === 'dark';
  const buttonClass = `grid size-12 shrink-0 place-items-center rounded-full shadow-[0_14px_42px_rgba(0,0,0,0.28)] backdrop-blur-xl max-[640px]:size-11 ${
    isDark
      ? 'bg-neutral-900/95 text-neutral-600'
      : 'bg-stone-100/95 text-neutral-400'
  }`;

  return (
    <section
      className="relative mx-auto grid w-full max-w-4xl min-w-0 grid-cols-[3rem_minmax(0,1fr)_3rem] items-end gap-2 max-[1400px]:ml-auto max-[1400px]:mr-0 max-[640px]:grid-cols-[2.75rem_minmax(0,1fr)]"
      data-prototype-dev-dock="unavailable"
    >
      <button
        aria-label="Prototype comments unavailable"
        className={buttonClass}
        disabled
        type="button"
      >
        <MessageSquarePlus className="size-[1.125rem]" />
      </button>

      <div
        className={`flex h-12 min-w-0 items-center gap-2 rounded-full p-1.5 shadow-[0_18px_58px_rgba(0,0,0,0.42)] backdrop-blur-xl max-[640px]:h-11 max-[640px]:p-1 ${
          isDark ? 'bg-neutral-900/95 text-neutral-500' : 'bg-stone-100/95 text-neutral-500'
        }`}
        role="status"
      >
        {isConnecting ? (
          <Loader2 className="ml-3 size-4 shrink-0 animate-spin" />
        ) : (
          <CircleAlert className="ml-3 size-4 shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate text-sm max-[640px]:text-xs">
          {message}
        </span>
        <button
          aria-label="Retry local Codex connection"
          className={`grid size-9 shrink-0 place-items-center rounded-full transition disabled:opacity-40 ${
            isDark
              ? 'bg-neutral-100 text-neutral-900 hover:bg-white'
              : 'bg-neutral-900 text-white hover:bg-black'
          }`}
          disabled={isConnecting}
          onClick={onRetry}
          type="button"
        >
          {isConnecting ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RefreshCw className="size-4" />
          )}
        </button>
      </div>

      <button
        aria-label="Codex history unavailable"
        className={`${buttonClass} max-[640px]:absolute max-[640px]:bottom-[calc(100%+0.5rem)] max-[640px]:right-0`}
        disabled
        type="button"
      >
        <Maximize2 className="size-[1.125rem]" />
      </button>
    </section>
  );
}
