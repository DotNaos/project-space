import { Network, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import {
  defaultProjectHomeView,
  type ProjectHomeView
} from './project-space-information-architecture';

export interface ProjectHomeCommandCenterProps {
  className?: string;
  defaultView?: ProjectHomeView;
  hasBottomTabBar?: boolean;
  map: ReactNode;
  onViewChange?(view: ProjectHomeView): void;
  selectedView?: ProjectHomeView;
  summary: ReactNode;
}

export function ProjectHomeCommandCenter({
  className,
  defaultView = defaultProjectHomeView,
  hasBottomTabBar = false,
  map,
  onViewChange,
  selectedView,
  summary
}: ProjectHomeCommandCenterProps) {
  const [localView, setLocalView] = useState(defaultView);
  const view = selectedView ?? localView;

  function selectView(nextView: ProjectHomeView) {
    if (selectedView === undefined) setLocalView(nextView);
    onViewChange?.(nextView);
  }

  return (
    <section
      aria-label="Home"
      className={cn('relative size-full min-h-0 overflow-hidden bg-app-panel', className)}
      data-home-view={view}
      data-testid="project-home-command-center"
    >
      {view === 'map' ? (
        <div className="relative size-full min-h-0 overflow-hidden" data-home-panel="map">
          {map}
          <Button
            aria-label="Close graph view"
            className="app-no-drag absolute top-3 right-14 z-50 size-8 min-h-0 border border-neutral-800 bg-neutral-950/90 shadow-lg backdrop-blur sm:right-3"
            data-testid="close-project-graph"
            isIconOnly
            onPress={() => selectView('summary')}
            size="sm"
            variant="ghost"
          >
            <X aria-hidden="true" className="size-4" />
          </Button>
        </div>
      ) : (
        <div className="relative size-full min-h-0" data-home-panel="summary">
          <div className="app-no-drag pointer-events-none absolute inset-x-0 top-0 z-40 flex h-14 items-center justify-end pr-14 pl-4 sm:px-6">
            <Button
              className="pointer-events-auto rounded-full border-neutral-700 bg-neutral-950/90 px-3 shadow-lg backdrop-blur"
              data-testid="open-project-graph"
              onPress={() => selectView('map')}
              size="sm"
              variant="outline"
            >
              <Network aria-hidden="true" className="size-3.5" />
              Graph view
            </Button>
          </div>
          <div
            className={cn(
              'size-full min-h-0 overflow-y-auto px-4 pt-16 sm:px-6',
              hasBottomTabBar
                ? 'pb-[calc(6.75rem+env(safe-area-inset-bottom))]'
                : 'pb-8'
            )}
          >
            {summary}
          </div>
        </div>
      )}
    </section>
  );
}
