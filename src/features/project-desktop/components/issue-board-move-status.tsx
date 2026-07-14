import { AlertTriangle, RotateCcw, X } from 'lucide-react';

export function IssueBoardMoveStatus({
  isRetrying,
  message,
  onDismiss,
  onRetry
}: {
  isRetrying: boolean;
  message: string;
  onDismiss(): void;
  onRetry(): void;
}) {
  return (
    <div
      role="alert"
      className="mb-2 flex shrink-0 items-center gap-2 rounded-xl border border-amber-500/20 bg-amber-500/5 px-2.5 py-1.5 text-amber-100"
    >
      <AlertTriangle className="size-4 shrink-0 text-amber-300" />
      <p className="min-w-0 flex-1 text-xs text-amber-100/80">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        disabled={isRetrying}
        className="inline-flex min-h-10 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition hover:bg-amber-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 disabled:opacity-50 sm:min-h-8"
      >
        <RotateCcw className="size-3.5" />
        {isRetrying ? 'Retrying…' : 'Retry'}
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss issue move error"
        className="flex size-10 shrink-0 items-center justify-center rounded-lg transition hover:bg-amber-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 sm:size-8"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
