import { LoaderCircle, Network } from 'lucide-react';
import { Surface, Text } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';

export function ProjectTopologyRoutePending({
  hasBottomTabBar = false
}: {
  hasBottomTabBar?: boolean;
}) {
  return (
    <Surface
      aria-busy="true"
      aria-label="Project command center"
      className={cn(
        'relative flex h-full min-h-0 overflow-hidden rounded-none bg-app-panel',
        hasBottomTabBar && 'pb-[calc(6.75rem+env(safe-area-inset-bottom))]'
      )}
      data-testid="project-topology-route"
      variant="transparent"
    >
      <div className="app-drag absolute inset-x-0 top-0 h-14" />
      <div className="app-no-drag relative flex min-w-0 items-center gap-3 self-start px-4 py-4 sm:px-6">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-neutral-800 bg-neutral-950">
          <Network aria-hidden="true" className="size-4 text-neutral-400" />
        </span>
        <span className="min-w-0">
          <Text as="h1" className="block truncate text-sm font-semibold text-neutral-100">
            Command center
          </Text>
          <span
            aria-live="polite"
            className="mt-1 flex items-center gap-1.5 text-xs text-neutral-400"
            role="status"
          >
            <LoaderCircle aria-hidden="true" className="size-3 animate-spin" />
            <Text>Checking portfolio data</Text>
          </span>
        </span>
      </div>
    </Surface>
  );
}
