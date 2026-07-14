import { CircleAlert, LoaderCircle, RefreshCw, TriangleAlert } from 'lucide-react';
import { Button, Surface, Text } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import type {
  ProjectTopologyReadState,
  ProjectTopologySnapshot
} from './project-topology-types';

export function TopologyReadBanner({
  hasHomeViewSwitcher = false,
  onRefresh,
  readState,
  snapshot
}: {
  hasHomeViewSwitcher?: boolean;
  onRefresh(): void;
  readState: ProjectTopologyReadState;
  snapshot: ProjectTopologySnapshot;
}) {
  const content = readState.state === 'checking'
    ? { icon: LoaderCircle, label: 'Refreshing portfolio data', tone: 'neutral' as const }
    : readState.state === 'stale'
      ? { icon: TriangleAlert, label: readState.reason, tone: 'warning' as const }
      : snapshot.warnings[0]
        ? {
            icon: TriangleAlert,
            label: snapshot.warnings.length === 1
              ? snapshot.warnings[0].message
              : `${snapshot.warnings[0].message} · +${snapshot.warnings.length - 1} more`,
            tone: 'warning' as const
          }
        : undefined;
  if (!content) {
    return (
      <div className={cn(
        'app-no-drag absolute right-3 z-40',
        hasHomeViewSwitcher ? 'top-16' : 'top-3'
      )}>
        <TopologyRefreshButton isRefreshing={false} onRefresh={onRefresh} />
      </div>
    );
  }
  const Icon = content.icon;
  return (
    <div
      aria-live="polite"
      className={cn(
        'app-no-drag absolute left-1/2 z-40 flex max-w-[min(42rem,calc(100%-1.5rem))] -translate-x-1/2 items-center gap-2 rounded-full border bg-neutral-950/95 px-3 py-2 text-xs shadow-xl backdrop-blur',
        hasHomeViewSwitcher ? 'top-16' : 'top-3',
        content.tone === 'warning'
          ? 'border-amber-900/70 text-amber-200'
          : 'border-neutral-800 text-neutral-300'
      )}
      role={readState.state === 'stale' ? 'alert' : 'status'}
      title={snapshot.warnings.map((warning) => warning.message).join('\n')}
    >
      <Icon
        aria-hidden="true"
        className={cn('size-3.5 shrink-0', readState.state === 'checking' && 'animate-spin')}
      />
      <Text className="truncate">{content.label}</Text>
      <TopologyRefreshButton
        isRefreshing={readState.state === 'checking'}
        onRefresh={onRefresh}
      />
    </div>
  );
}

function TopologyRefreshButton({
  isRefreshing,
  onRefresh
}: {
  isRefreshing: boolean;
  onRefresh(): void;
}) {
  return (
    <Button
      aria-label="Refresh portfolio data"
      className="size-7 min-h-0 shrink-0 border border-neutral-800 bg-neutral-950/90 shadow-lg backdrop-blur"
      data-testid="project-topology-refresh"
      isDisabled={isRefreshing}
      isIconOnly
      onPress={onRefresh}
      size="sm"
      variant="ghost"
    >
      <RefreshCw
        aria-hidden="true"
        className={cn('size-3.5', isRefreshing && 'animate-spin')}
      />
    </Button>
  );
}

export function TopologyUnavailable({
  hasBottomTabBar,
  onRetry,
  reason
}: {
  hasBottomTabBar: boolean;
  onRetry(): void;
  reason: string;
}) {
  return (
    <Surface
      className={cn(
        'flex size-full min-h-0 items-start rounded-none bg-app-panel px-4 py-4 sm:px-6',
        hasBottomTabBar && 'pb-[calc(6.75rem+env(safe-area-inset-bottom))]'
      )}
      data-testid="project-topology-blocked"
      variant="transparent"
    >
      <div className="app-no-drag flex max-w-xl items-start gap-3" role="alert">
        <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-red-300" />
        <span className="min-w-0">
          <Text as="h1" className="block text-sm font-semibold text-neutral-100">
            Portfolio data is unavailable
          </Text>
          <Text className="mt-1 block text-xs leading-5 text-neutral-400">{reason}</Text>
          <Button className="mt-3" onPress={onRetry} size="sm" variant="outline">
            <RefreshCw aria-hidden="true" className="size-3.5" />
            Retry
          </Button>
        </span>
      </div>
    </Surface>
  );
}
