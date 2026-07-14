import { Tabs } from '@heroui/react';
import { LayoutDashboard, Network } from 'lucide-react';
import { useState, type Key, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import {
  defaultProjectHomeView,
  type ProjectHomeView
} from './project-space-information-architecture';

export interface ProjectHomeCommandCenterProps {
  className?: string;
  defaultView?: ProjectHomeView;
  map: ReactNode;
  onViewChange?(view: ProjectHomeView): void;
  selectedView?: ProjectHomeView;
  summary: ReactNode;
}

export function ProjectHomeCommandCenter({
  className,
  defaultView = defaultProjectHomeView,
  map,
  onViewChange,
  selectedView,
  summary
}: ProjectHomeCommandCenterProps) {
  const [localView, setLocalView] = useState(defaultView);
  const view = selectedView ?? localView;

  function selectView(key: Key) {
    if (key !== 'map' && key !== 'summary') return;
    if (selectedView === undefined) setLocalView(key);
    onViewChange?.(key);
  }

  return (
    <section
      aria-label="Home"
      className={cn('relative size-full min-h-0 overflow-hidden bg-app-panel', className)}
      data-home-view={view}
      data-testid="project-home-command-center"
    >
      <Tabs.Root
        className="size-full min-h-0"
        onSelectionChange={selectView}
        selectedKey={view}
        variant="secondary"
      >
        <Tabs.ListContainer className="app-no-drag pointer-events-none absolute inset-x-0 top-3 z-40 flex justify-center px-3">
          <Tabs.List
            aria-label="Home view"
            className="pointer-events-auto rounded-full border border-neutral-800 bg-neutral-950/90 p-1 shadow-[0_12px_36px_rgba(0,0,0,0.32)] backdrop-blur"
          >
            <Tabs.Tab className="gap-1.5 rounded-full px-3" id="map">
              <Network aria-hidden="true" className="size-3.5" />
              Map
              <Tabs.Indicator className="rounded-full" />
            </Tabs.Tab>
            <Tabs.Tab className="gap-1.5 rounded-full px-3" id="summary">
              <LayoutDashboard aria-hidden="true" className="size-3.5" />
              Summary
              <Tabs.Indicator className="rounded-full" />
            </Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>

        <Tabs.Panel
          className="size-full min-h-0 overflow-hidden outline-none"
          id="map"
          shouldForceMount
        >
          {map}
        </Tabs.Panel>
        <Tabs.Panel
          className="size-full min-h-0 overflow-y-auto px-4 pb-8 pt-20 outline-none sm:px-6"
          id="summary"
          shouldForceMount
        >
          {summary}
        </Tabs.Panel>
      </Tabs.Root>
    </section>
  );
}
