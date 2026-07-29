import { Popover } from '@heroui/react';

import type { CodexSessionTokenUsage } from '@/shared/codex-sessions-api';

export function PrototypeReviewCodexContextControl({
  isDark,
  tokenUsage
}: {
  isDark: boolean;
  tokenUsage?: CodexSessionTokenUsage;
}) {
  const contextWindow = tokenUsage?.modelContextWindow;
  const inputTokens = tokenUsage?.last.inputTokens;
  const progress = contextWindow && inputTokens !== undefined
    ? Math.min(1, inputTokens / contextWindow)
    : undefined;
  const percentage = progress === undefined ? undefined : Math.round(progress * 100);

  return (
    <Popover>
      <Popover.Trigger
        aria-label={
          percentage === undefined
            ? 'Context window usage unavailable'
            : `Context window ${percentage}% used`
        }
        className={`grid size-9 shrink-0 cursor-pointer place-items-center rounded-full outline-none transition focus-visible:ring-2 ${
          isDark
            ? 'text-neutral-400 hover:bg-neutral-700/80 hover:text-neutral-100 focus-visible:ring-neutral-600'
            : 'text-neutral-500 hover:bg-white hover:text-neutral-900 focus-visible:ring-neutral-300'
        }`}
        title="Context window"
      >
        <ContextRing progress={progress} />
      </Popover.Trigger>
      <Popover.Content
        className={`w-64 rounded-2xl border p-4 shadow-2xl backdrop-blur-xl ${
          isDark
            ? 'border-neutral-700 bg-neutral-900/96 text-neutral-100 shadow-black/60'
            : 'border-stone-200 bg-white/96 text-neutral-900 shadow-black/20'
        }`}
        offset={8}
        placement="top"
      >
        <Popover.Dialog className="outline-none">
          <p className="text-sm font-semibold">Context window</p>
          {contextWindow && inputTokens !== undefined ? (
            <>
              <p className="mt-1 text-xs text-neutral-500">
                {formatTokens(inputTokens)} of {formatTokens(contextWindow)} used for the latest response
              </p>
              <div className={`mt-3 h-1.5 overflow-hidden rounded-full ${
                isDark ? 'bg-neutral-700' : 'bg-stone-200'
              }`}>
                <div
                  className="h-full rounded-full bg-sky-500 transition-[width] duration-300"
                  style={{ width: `${percentage}%` }}
                />
              </div>
              <p className="mt-2 text-[11px] text-neutral-500">
                {formatTokens(tokenUsage.total.totalTokens)} tokens processed in this task
              </p>
            </>
          ) : (
            <p className="mt-1 text-xs leading-5 text-neutral-500">
              Codex has not reported context usage for this task yet. It will appear during the next response.
            </p>
          )}
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}

function ContextRing({ progress }: { progress?: number }) {
  const circumference = 2 * Math.PI * 7;
  const offset = progress === undefined
    ? circumference * 0.72
    : circumference * (1 - progress);
  return (
    <svg
      aria-hidden="true"
      className="size-[1.125rem] -rotate-90"
      fill="none"
      viewBox="0 0 18 18"
    >
      <circle
        className="stroke-current opacity-30"
        cx="9"
        cy="9"
        r="7"
        strokeWidth="2"
      />
      <circle
        className="stroke-current"
        cx="9"
        cy="9"
        r="7"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        strokeWidth="2"
      />
    </svg>
  );
}

function formatTokens(value: number) {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: value >= 10_000 ? 0 : 1,
    notation: value >= 1_000 ? 'compact' : 'standard'
  }).format(value);
}
