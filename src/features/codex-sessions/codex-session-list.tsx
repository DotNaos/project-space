import { Spinner } from '@heroui/react';
import {
  Bot,
  ChevronRight,
  Circle,
  CircleAlert,
  GitPullRequest,
  Monitor,
  Search,
  WifiOff,
  Wrench
} from 'lucide-react';
import {
  Button,
  SearchField,
  SearchFieldClearButton,
  SearchFieldGroup,
  SearchFieldInput,
  Text
} from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import type { MachineRecord, MachineRuntimeStatusResult } from '@/shared/project-space-api';
import {
  aggregateCodexInventoryTruth,
  codexInventoryTruth,
  type CodexInventoryTruth
} from './codex-inventory-truth';
import {
  effectiveCodexSessionStatus,
  groupCodexSessions
} from './codex-sessions-model';
import { parseProjectCodexTaskTitle } from './project-codex-task-model';
import type {
  CodexMachine,
  CodexSession,
  CodexSessionStatus,
  CodexThreadOrigin
} from './codex-sessions-types';

const statusTone: Record<CodexSessionStatus, string> = {
  active: 'text-emerald-400',
  archived: 'text-neutral-600',
  idle: 'text-neutral-400',
  missing: 'text-amber-400',
  offline: 'text-neutral-600',
  unavailable: 'text-red-400'
};

function SessionRow({
  machine,
  onSelect,
  selected,
  session,
}: {
  machine: CodexMachine;
  onSelect(session: CodexSession): void;
  selected: boolean;
  session: CodexSession;
}) {
  const status = effectiveCodexSessionStatus(session, machine);
  const task = parseProjectCodexTaskTitle(session.title);
  return (
    <button
      aria-current={selected ? 'page' : undefined}
      className={cn(
        'group flex w-full min-w-0 items-start gap-3 border-l-2 px-3 py-3 text-left transition-colors duration-200',
        selected
          ? 'border-neutral-100 bg-neutral-900 text-neutral-100'
          : 'border-transparent text-neutral-300 hover:bg-neutral-900/60 hover:text-neutral-100'
      )}
      onClick={() => onSelect(session)}
      type="button"
    >
      <Bot className="mt-0.5 size-4 shrink-0 text-neutral-500" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <Text className="truncate text-xs font-medium">{task.title}</Text>
          <ChevronRight className="ml-auto size-3 shrink-0 text-neutral-700 group-hover:text-neutral-500" />
        </span>
        <span className="mt-1 flex min-w-0 items-center gap-1.5 text-[10px] text-neutral-500">
          {status === 'active' ? (
            <Spinner className="text-emerald-300" size="sm" />
          ) : (
            <Circle className={cn('size-1.5 shrink-0 fill-current', statusTone[status])} />
          )}
          <span>{status === 'active' ? 'Active' : status === 'missing' ? 'No longer available' : status}</span>
          {task.issueNumber ? <span>Issue #{task.issueNumber}</span> : null}
          {task.pullRequestNumber ? (
            <span className="inline-flex items-center gap-1"><GitPullRequest className="size-2.5" />PR #{task.pullRequestNumber}</span>
          ) : null}
        </span>
      </span>
    </button>
  );
}

export function CodexSessionList({
  connectorInstallations,
  isConnectorRefreshing = false,
  loadingMachineIds = [],
  machines,
  now,
  onManageConnector,
  onSelect,
  query,
  selectedOrigin,
  sessions,
  setQuery,
  runtimeByMachineId = {}
}: {
  connectorInstallations?: MachineRecord[];
  isConnectorRefreshing?: boolean;
  loadingMachineIds?: string[];
  machines: CodexMachine[];
  now: Date;
  onManageConnector?(machineId: string): void;
  onSelect(session: CodexSession): void;
  query: string;
  selectedOrigin?: CodexThreadOrigin;
  sessions: CodexSession[];
  setQuery(value: string): void;
  runtimeByMachineId?: Record<string, MachineRuntimeStatusResult>;
}) {
  const installations = connectorInstallations ?? [];
  const connectorOverviewKnown = connectorInstallations !== undefined;
  const inventoryByMachineId = new Map(machines.map((machine) => [machine.id, machine]));
  const connectorByMachineId = new Map(
    installations.map((connector) => [connector.id, connector])
  );
  const displayMachines = connectorOverviewKnown
    ? installations.map((connector): CodexMachine => (
          inventoryByMachineId.get(connector.id) ?? {
            id: connector.id,
            name: connector.name,
            status: connector.connector.status === 'local' || connector.connector.status === 'online'
              ? 'connected'
              : connector.connector.status === 'offline'
                ? 'offline'
                : 'unavailable'
          }
        ))
    : machines;
  const displayMachineIds = new Set(displayMachines.map((machine) => machine.id));
  const displaySessionCount = sessions.filter(
    (session) => displayMachineIds.has(session.machineId)
  ).length;
  const truthByMachineId = new Map(displayMachines.map((machine) => [
    machine.id,
    codexInventoryTruth({
      connector: connectorByMachineId.get(machine.id),
      connectorRequired: connectorOverviewKnown,
      inventory: machine,
      loading: loadingMachineIds.includes(machine.id),
      now,
      overviewRefreshing: isConnectorRefreshing,
      runtime: runtimeByMachineId[machine.id]
    })
  ]));
  const overallTruth = aggregateCodexInventoryTruth(
    truthByMachineId.size > 0
      ? [...truthByMachineId.values()]
      : [codexInventoryTruth({
          connectorRequired: connectorOverviewKnown,
          now,
          overviewRefreshing: isConnectorRefreshing
        })]
  );
  const matchingGroups = groupCodexSessions(displayMachines, sessions, query);
  const matchingGroupByMachineId = new Map(
    matchingGroups.map((group) => [group.machine.id, group])
  );
  const groups = displayMachines.flatMap((machine) => {
    const matching = matchingGroupByMachineId.get(machine.id);
    if (matching) return [matching];
    return truthByMachineId.get(machine.id)?.state !== 'ready'
      ? [{ machine, sections: [] }]
      : [];
  });
  const resultCount = groups.reduce(
    (count, group) => count + group.sections.reduce((sum, section) => sum + section.sessions.length, 0),
    0
  );
  const manageMachineId = [...truthByMachineId.entries()].find(
    ([, value]) => value.state === overallTruth.state
  )?.[0] ?? [...truthByMachineId.entries()].find(
    ([, value]) => value.state !== 'ready'
  )?.[0];

  return (
    <section aria-label="Codex sessions" className="flex h-full min-h-0 flex-col bg-neutral-950">
      <header className="shrink-0 border-b border-neutral-800/80 px-4 pb-3 pt-4">
        <div className="flex items-center gap-2 pr-10 min-[1120px]:pr-0">
          <Text as="h1" className="text-sm font-semibold text-neutral-100">Codex</Text>
          <Text className={cn(
            'ml-auto text-[10px]',
            overallTruth.state === 'ready' ? 'text-neutral-500' : truthTone(overallTruth)
          )}>
            {overallTruth.state === 'ready' ? `${displaySessionCount} sessions` : overallTruth.label}
          </Text>
        </div>
        <SearchField
          aria-label="Search Codex sessions"
          className="mt-3 rounded-lg border border-neutral-800 bg-neutral-900/60"
          onChange={setQuery}
          value={query}
        >
          <SearchFieldGroup>
            <Search className="size-3.5 shrink-0 text-neutral-500" />
            <SearchFieldInput aria-label="Search by title, project, directory, model, or connector" placeholder="Search sessions" />
            <SearchFieldClearButton />
          </SearchFieldGroup>
        </SearchField>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto py-2">
        {overallTruth.state !== 'ready' && groups.length === 0 ? (
          <InventoryStateNotice
            machineId={manageMachineId}
            onManageConnector={onManageConnector}
            truth={overallTruth}
          />
        ) : null}
        {resultCount === 0 && query && overallTruth.state === 'ready' ? (
          <div className="px-5 py-10 text-center">
            <Search className="mx-auto size-5 text-neutral-600" />
            <Text className="mt-3 block text-xs text-neutral-400">
              {`No sessions match “${query}”.`}
            </Text>
          </div>
        ) : groups.map(({ machine, sections }) => {
          const machineTruth = truthByMachineId.get(machine.id) ?? codexInventoryTruth({ inventory: machine, now });
          return (
          <section className="mb-3" key={machine.id}>
            <div className="flex items-center gap-2 px-4 py-2">
              {machineTruth.state === 'checking'
                ? <Spinner size="sm" />
                : machine.status === 'offline' || machineTruth.state === 'blocked'
                ? <WifiOff className="size-3.5 text-neutral-600" />
                : <Monitor className="size-3.5 text-neutral-500" />}
              <Text className="truncate text-[11px] font-semibold text-neutral-300">{machine.name}</Text>
              <Text className={cn(
                'ml-auto text-[9px]',
                truthTone(machineTruth)
              )}>{machineTruth.label}</Text>
            </div>
            {machineTruth.state !== 'ready' ? (
              <div className="px-4 py-3">
                <Text className="block text-[10px] leading-4 text-neutral-600">
                  {machineTruth.detail}
                </Text>
                {onManageConnector ? (
                  <Button
                    className="mt-2"
                    onPress={() => onManageConnector(machine.id)}
                    size="sm"
                    variant="ghost"
                  >
                    <Wrench className="size-3" /> Manage connector
                  </Button>
                ) : null}
              </div>
            ) : sections.length === 0 ? (
              <div className="px-4 py-3">
                <Text className="block text-[10px] leading-4 text-neutral-600">
                  The compatible connector reported no Codex sessions.
                </Text>
              </div>
            ) : null}
            {sections.map((section) => (
              <div className="mb-2" key={section.id}>
                <Text className="block px-4 pb-1 pt-2 text-[9px] font-semibold uppercase tracking-[0.14em] text-neutral-600">
                  {section.label}
                </Text>
                {section.sessions.map((session) => (
                  <SessionRow
                    key={`${session.machineId}:${session.threadId}`}
                    machine={machine}
                    onSelect={onSelect}
                    selected={
                      selectedOrigin?.machineId === session.machineId
                      && selectedOrigin.threadId === session.threadId
                    }
                    session={session}
                  />
                ))}
              </div>
            ))}
          </section>
          );
        })}
      </div>
    </section>
  );
}

function truthTone(truth: CodexInventoryTruth) {
  switch (truth.state) {
    case 'ready': return 'text-emerald-500';
    case 'checking': return 'text-neutral-400';
    case 'updating':
    case 'restarting': return 'text-sky-300';
    case 'update-required': return 'text-amber-300';
    case 'blocked': return 'text-red-300/80';
  }
}

function InventoryStateNotice({
  machineId,
  onManageConnector,
  truth
}: {
  machineId?: string;
  onManageConnector?(machineId: string): void;
  truth: CodexInventoryTruth;
}) {
  return (
    <div className="mx-3 mb-2 flex items-start gap-3 border-b border-neutral-800/80 px-2 py-3">
      {truth.state === 'checking' || truth.state === 'updating' || truth.state === 'restarting' ? (
        <Spinner className="mt-0.5" size="sm" />
      ) : (
        <CircleAlert className={cn('mt-0.5 size-4 shrink-0', truthTone(truth))} />
      )}
      <div className="min-w-0 flex-1">
        <Text className={cn('block text-xs font-medium', truthTone(truth))}>{truth.label}</Text>
        <Text className="mt-1 block text-[10px] leading-4 text-neutral-500">{truth.detail}</Text>
        {machineId && onManageConnector ? (
          <Button
            className="mt-2"
            onPress={() => onManageConnector(machineId)}
            size="sm"
            variant="ghost"
          >
            <Wrench className="size-3" /> Manage connector
          </Button>
        ) : null}
      </div>
    </div>
  );
}
