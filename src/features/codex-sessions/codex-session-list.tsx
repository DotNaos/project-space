import { useEffect, useState } from 'react';
import { Spinner } from '@heroui/react';
import {
  Archive,
  ChevronDown,
  Circle,
  Cloud,
  Folder,
  Inbox,
  MessageCircleQuestion,
  Search,
  ShieldAlert,
  WifiOff
} from 'lucide-react';
import { Text } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import type {
  ConnectorInstallationRecord,
  PhysicalMachineRecord,
  ProjectSpaceRecord
} from '@/shared/project-space-api';
import { CodexSessionFilters } from './codex-session-filters';
import {
  ALL_CODEX_CONNECTORS,
  buildCodexSessionListViewModel,
  codexSessionStatusPresentation
} from './codex-session-list-model';
import { formatCodexActivity } from './codex-sessions-model';
import type {
  CodexMachine,
  CodexSession,
  CodexThreadOrigin
} from './codex-sessions-types';

function statusTone(label: string) {
  if (label === 'Working') return 'text-emerald-400';
  if (label.includes('Approval') || label.includes('Input') || label === 'No longer available') {
    return 'text-amber-400';
  }
  if (label.includes('Unavailable')) return 'text-red-400';
  return 'text-neutral-500';
}

function StatusIcon({ indicator, label }: { indicator: 'dot' | 'spinner'; label: string }) {
  if (indicator === 'spinner') {
    return <Spinner aria-hidden="true" className={statusTone(label)} size="sm" />;
  }
  if (label.includes('Approval')) return <ShieldAlert aria-hidden="true" className="size-3.5 text-amber-400" />;
  if (label.includes('Input')) return <MessageCircleQuestion aria-hidden="true" className="size-3.5 text-amber-400" />;
  if (label.includes('Offline')) return <WifiOff aria-hidden="true" className="size-3.5 text-neutral-600" />;
  if (label === 'Archived') return <Archive aria-hidden="true" className="size-3.5 text-neutral-600" />;
  return <Circle aria-hidden="true" className={cn('size-2 fill-current', statusTone(label))} />;
}

function SessionRow({
  isRemote,
  machine,
  now,
  onSelect,
  selected,
  session,
  checking
}: {
  checking: boolean;
  isRemote: boolean;
  machine?: CodexMachine;
  now: Date;
  onSelect(session: CodexSession): void;
  selected: boolean;
  session: CodexSession;
}) {
  const status = codexSessionStatusPresentation({ checking, machine, session });
  return (
    <button
      aria-current={selected ? 'page' : undefined}
      aria-label={`Open task ${session.title}. ${status.label}.`}
      className={cn(
        'group flex min-h-11 w-full min-w-0 items-center gap-2.5 border-l-2 px-3 py-2 text-left transition-colors duration-150',
        'focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-neutral-400',
        selected
          ? 'border-neutral-300 bg-neutral-800/90 text-neutral-100'
          : 'border-transparent text-neutral-300 hover:bg-neutral-900/70 hover:text-neutral-100'
      )}
      onClick={() => onSelect(session)}
      title={session.title}
      type="button"
    >
      <span className="flex size-5 shrink-0 items-center justify-center">
        <StatusIcon indicator={status.indicator} label={status.label} />
      </span>
      <span className="min-w-0 flex-1">
        <Text className="block truncate text-[11px] font-medium leading-4 text-current">
          {session.title}
        </Text>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[9px] leading-3 text-neutral-600">
          <span className={cn('truncate', statusTone(status.label))}>{status.label}</span>
          <span aria-hidden="true">·</span>
          <span className="shrink-0">{formatCodexActivity(session.lastActivityAt, now)}</span>
          {isRemote ? (
            <span className="ml-auto inline-flex shrink-0 items-center gap-1" title="Remote connector">
              <Cloud aria-hidden="true" className="size-3" /> Remote
            </span>
          ) : null}
        </span>
      </span>
    </button>
  );
}

export function CodexSessionList({
  connectorInstallations = [],
  loadingMachineIds = [],
  machines,
  now,
  onSelect,
  onSelectConnector,
  onSelectMachine,
  physicalMachines = [],
  projects = [],
  query,
  selectedConnectorKey,
  selectedMachineKey,
  selectedOrigin,
  sessions,
  setQuery
}: {
  connectorInstallations?: ConnectorInstallationRecord[];
  loadingMachineIds?: string[];
  machines: CodexMachine[];
  now: Date;
  onSelect(session: CodexSession): void;
  onSelectConnector(key: string): void;
  onSelectMachine(key: string): void;
  physicalMachines?: PhysicalMachineRecord[];
  projects?: ProjectSpaceRecord[];
  query: string;
  selectedConnectorKey: string;
  selectedMachineKey: string;
  selectedOrigin?: CodexThreadOrigin;
  sessions: CodexSession[];
  setQuery(value: string): void;
}) {
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(() => new Set());
  const model = buildCodexSessionListViewModel({
    connectorInstallations,
    loadingMachineIds,
    machines,
    physicalMachines,
    projects,
    query,
    selectedConnectorKey,
    selectedMachineKey,
    sessions
  });
  const machineById = new Map(machines.map((machine) => [machine.id, machine]));
  const remoteConnectorIds = new Set(connectorInstallations.flatMap((connector) => (
    connector.connector.status === 'online' ? [connector.id] : []
  )));

  useEffect(() => {
    if (model.normalizedMachineKey !== selectedMachineKey) {
      onSelectMachine(model.normalizedMachineKey);
    }
  }, [model.normalizedMachineKey, onSelectMachine, selectedMachineKey]);

  useEffect(() => {
    if (model.normalizedConnectorKey !== selectedConnectorKey) {
      onSelectConnector(model.normalizedConnectorKey);
    }
  }, [model.normalizedConnectorKey, onSelectConnector, selectedConnectorKey]);

  return (
    <section aria-label="Codex tasks" className="flex h-full min-h-0 flex-col bg-neutral-950">
      <header className="shrink-0 border-b border-neutral-800/80 px-3 pb-3 pt-3 sm:px-4">
        <div className="flex items-center gap-2 pr-11 md:pr-0">
          <Text as="h1" className="text-sm font-semibold text-neutral-100">Codex</Text>
          <Text className="ml-auto text-[10px] tabular-nums text-neutral-500">
            {model.resultCount} of {sessions.length} tasks
          </Text>
        </div>
        <CodexSessionFilters
          connectorOptions={model.connectorOptions}
          machineOptions={model.machineOptions}
          onConnectorChange={onSelectConnector}
          onMachineChange={(key) => {
            onSelectMachine(key);
            onSelectConnector(ALL_CODEX_CONNECTORS);
          }}
          query={query}
          selectedConnectorKey={model.normalizedConnectorKey}
          selectedMachineKey={model.normalizedMachineKey}
          setQuery={setQuery}
        />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-2">
        <div className="flex items-center px-4 pb-1 pt-1">
          <Text className="text-[10px] font-semibold uppercase tracking-[0.14em] text-neutral-500">
            Projects
          </Text>
        </div>
        {model.resultCount === 0 ? (
          <div className="px-5 py-12 text-center">
            {query ? <Search className="mx-auto size-5 text-neutral-700" /> : <Inbox className="mx-auto size-5 text-neutral-700" />}
            <Text className="mt-3 block text-xs text-neutral-400">
              {query ? `No tasks match “${query}”.` : 'No tasks are available for these filters.'}
            </Text>
            <Text className="mt-1 block text-[10px] text-neutral-600">
              Try another machine or connector installation.
            </Text>
          </div>
        ) : model.projectGroups.map((group) => {
          const collapsed = !query && collapsedProjectIds.has(group.id);
          const contentId = `codex-project-${encodeURIComponent(group.id)}`;
          return (
            <section className="border-b border-neutral-900/90 last:border-b-0" key={group.id}>
              <button
                aria-controls={contentId}
                aria-expanded={!collapsed}
                className="flex h-9 w-full items-center gap-2 px-3 text-left text-neutral-400 transition hover:bg-neutral-900/50 hover:text-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-neutral-500"
                onClick={() => setCollapsedProjectIds((current) => {
                  const next = new Set(current);
                  if (next.has(group.id)) next.delete(group.id);
                  else next.add(group.id);
                  return next;
                })}
                type="button"
              >
                <ChevronDown className={cn('size-3.5 shrink-0 transition-transform duration-200', collapsed && '-rotate-90')} />
                <Folder className="size-3.5 shrink-0" />
                <Text className="min-w-0 flex-1 truncate text-[11px] font-semibold">{group.label}</Text>
                <Text className="text-[9px] tabular-nums text-neutral-600">{group.sessions.length}</Text>
              </button>
              <div hidden={collapsed} id={contentId}>
                {group.sessions.map((session) => (
                  <SessionRow
                    checking={loadingMachineIds.includes(session.machineId)}
                    isRemote={remoteConnectorIds.has(session.machineId)}
                    key={`${session.machineId}:${session.threadId}`}
                    machine={machineById.get(session.machineId)}
                    now={now}
                    onSelect={onSelect}
                    selected={
                      selectedOrigin?.machineId === session.machineId
                      && selectedOrigin.threadId === session.threadId
                    }
                    session={session}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </section>
  );
}
