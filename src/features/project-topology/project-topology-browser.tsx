import { useEffect, useState } from 'react';
import {
  CircleDot,
  Monitor,
  MonitorOff,
  Radio,
  TerminalSquare
} from 'lucide-react';
import {
  Chip,
  Tab,
  TabIndicator,
  TabList,
  Tabs,
  Text
} from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import { topologyBrowserPresentation } from './project-topology-presentation';
import type {
  TopologyBrowserCapability,
  TopologyBrowserTool
} from './project-topology-types';
import type { TopologyWorkspaceToolView } from './project-topology-view-model';

const toolLabels: Record<TopologyBrowserTool, string> = {
  console: 'Console',
  logs: 'Logs',
  network: 'Network'
};

export type TopologyBrowserToolEvents = Partial<
  Record<TopologyBrowserTool, readonly string[]>
>;

export function TopologyBrowserCapabilityNote({
  browser,
  compact = false
}: {
  browser: TopologyBrowserCapability;
  compact?: boolean;
}) {
  const presentation = topologyBrowserPresentation(browser);
  const Icon = browser.state === 'ready' ? Monitor : MonitorOff;
  return (
    <span
      className={cn(
        'inline-flex min-w-0 items-center gap-1.5 text-neutral-600',
        compact ? 'text-[7px]' : 'text-[9px]',
        browser.state === 'blocked' && 'text-red-300/65'
      )}
      title={presentation.reason}
    >
      <Icon className={compact ? 'size-2.5' : 'size-3'} />
      <span className="truncate">{presentation.label}</span>
    </span>
  );
}

export function TopologyReadOnlyBrowserFrame({
  compact = false,
  frameUrl,
  title
}: {
  compact?: boolean;
  frameUrl: string;
  title: string;
}) {
  return (
    <section
      aria-label={`${title} browser preview`}
      className="flex size-full min-h-0 min-w-0 flex-col overflow-hidden bg-neutral-950/80"
      data-browser-interaction="read-only"
    >
      <div className={cn(
        'flex shrink-0 items-center gap-1.5 border-b border-neutral-800/70 px-2.5 text-neutral-600',
        compact ? 'h-7 text-[7px]' : 'h-9 text-[9px]'
      )}>
        <Monitor className={compact ? 'size-2.5' : 'size-3'} />
        <Text className="truncate text-neutral-400">Live browser</Text>
        <Chip className="ml-auto" size="sm">Read-only</Chip>
        <span className="size-1.5 rounded-full bg-emerald-400" />
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden bg-black">
        <iframe
          aria-label={`${title} read-only browser session`}
          className="pointer-events-none size-full border-0 bg-black"
          referrerPolicy="no-referrer"
          sandbox=""
          src={frameUrl}
          tabIndex={-1}
          title={`${title} read-only browser session`}
        />
        <div
          aria-hidden="true"
          className="pointer-events-auto absolute inset-0 cursor-default"
          data-browser-input="blocked"
        />
      </div>
    </section>
  );
}

export function TopologyDeveloperTools({
  eventsByTool,
  tools
}: {
  eventsByTool?: TopologyBrowserToolEvents;
  tools: TopologyWorkspaceToolView[];
}) {
  const [selected, setSelected] = useState<TopologyBrowserTool | undefined>(tools[0]?.kind);
  useEffect(() => {
    if (!selected || !tools.some((tool) => tool.kind === selected)) {
      setSelected(tools[0]?.kind);
    }
  }, [selected, tools]);

  if (tools.length === 0 || !selected) return null;
  const events = eventsByTool?.[selected];
  return (
    <section
      aria-label="Browser developer tools"
      className="flex min-h-32 shrink-0 flex-col border-t border-neutral-800/80 bg-neutral-950"
      data-browser-tools="available"
    >
      <Tabs
        className="shrink-0 border-b border-neutral-800/80 px-2"
        onSelectionChange={(key) => setSelected(key as TopologyBrowserTool)}
        selectedKey={selected}
      >
        <TabList aria-label="Available browser tools" className="flex h-9 items-center">
          <TerminalSquare className="mr-1 size-3.5 text-neutral-600" />
          {tools.map((tool) => (
            <Tab className="min-h-7 rounded-md px-2 text-[10px]" id={tool.kind} key={tool.kind}>
              {toolLabels[tool.kind]}
              <TabIndicator />
            </Tab>
          ))}
        </TabList>
      </Tabs>
      <div
        aria-label={`${toolLabels[selected]} live stream`}
        className="min-h-0 flex-1 overflow-auto p-3 font-mono text-[10px] leading-5 text-neutral-500"
        role="tabpanel"
      >
        {events === undefined ? (
          <span className="flex items-center gap-2 font-sans text-neutral-600">
            <Radio className="size-3" />
            Live {toolLabels[selected].toLowerCase()} stream available
          </span>
        ) : events.length > 0 ? (
          <div className="grid gap-1">
            {events.map((event, index) => (
              <Text as="p" className="break-all" key={`${selected}:${index}:${event}`}>
                {event}
              </Text>
            ))}
          </div>
        ) : (
          <span className="flex items-center gap-2 font-sans text-neutral-600">
            <CircleDot className="size-3" />
            No events received in this view
          </span>
        )}
      </div>
    </section>
  );
}
