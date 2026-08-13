import { CircleStop, LoaderCircle, Play, Trash2 } from 'lucide-react';
import { Button } from '@/app/dotnaos-ui';

interface GitHubCodespaceActionsProps {
  busy?: string;
  className?: string;
  onDelete(): void;
  onStart(): void;
  onStop(): void;
  state: string;
}

const startingStates = new Set(['provisioning', 'queued', 'rebuilding', 'starting']);
const stoppingStates = new Set(['shuttingdown', 'stopping']);

export function GitHubCodespaceActions({
  busy = '',
  className = 'mx-3',
  onDelete,
  onStart,
  onStop,
  state
}: GitHubCodespaceActionsProps) {
  const normalizedState = state.toLowerCase();
  const isOnline = normalizedState === 'available';
  const isOffline = normalizedState === 'shutdown';
  const isStarting = busy === 'start' || startingStates.has(normalizedState);
  const isStopping = busy === 'stop' || stoppingStates.has(normalizedState);
  const hasLifecycleAction = isOnline || isOffline || isStarting || isStopping;
  const columns = hasLifecycleAction
    ? 'grid-cols-2'
    : 'grid-cols-1';

  return (
    <div className={`${className} grid gap-1.5 ${columns}`}>
      {isOffline || isStarting ? (
        <Button
          className="h-8 min-w-0 !rounded-full !bg-blue-500 px-2 !text-white hover:!bg-blue-400"
          isDisabled={Boolean(busy) || isStarting}
          size="sm"
          variant="primary"
          onPress={onStart}
        >
          {isStarting
            ? <LoaderCircle aria-hidden className="size-3.5 shrink-0 animate-spin" />
            : <Play aria-hidden className="size-3.5 shrink-0" />}
          {isStarting ? 'Starting…' : 'Start Codespace'}
        </Button>
      ) : null}
      {isOnline || isStopping ? (
        <Button
          className="h-8 min-w-0 !rounded-full !bg-amber-400/10 px-2 !text-amber-200 hover:!bg-amber-400/20"
          isDisabled={Boolean(busy) || isStopping}
          size="sm"
          variant="ghost"
          onPress={onStop}
        >
          {isStopping
            ? <LoaderCircle aria-hidden className="size-3.5 shrink-0 animate-spin" />
            : <CircleStop aria-hidden className="size-3.5 shrink-0" />}
          {isStopping ? 'Stopping…' : 'Stop'}
        </Button>
      ) : null}
      <Button
        className="h-8 min-w-0 !rounded-full !bg-red-400/10 px-2 !text-red-200 hover:!bg-red-400/20"
        isDisabled={Boolean(busy)}
        size="sm"
        variant="ghost"
        onPress={onDelete}
      >
        <Trash2 aria-hidden className="size-3.5 shrink-0" /> Delete
      </Button>
    </div>
  );
}
