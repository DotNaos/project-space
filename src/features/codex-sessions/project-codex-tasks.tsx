import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Drawer, Spinner } from '@heroui/react';
import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  Circle,
  Clock3,
  GitBranch,
  History,
  MonitorOff,
  Radio,
  Server,
  WifiOff,
  X
} from 'lucide-react';
import {
  Button,
  Chip,
  SearchField,
  SearchFieldClearButton,
  SearchFieldGroup,
  SearchFieldInput,
  SearchFieldSearchIcon,
  Text
} from '@/app/dotnaos-ui';
import type { ConnectorOverviewResult, ProjectSpaceRecord } from '@/shared/project-space-api';
import { cn } from '@/lib/utils';
import type { CodexSessionsController } from './codex-sessions-controller';
import {
  aggregateCodexInventoryTruth,
  codexInventoryTruth,
  type CodexInventoryTruth
} from './codex-inventory-truth';
import {
  countActiveProjectCodexTasks,
  groupProjectCodexTasks,
  presentProjectCodexTaskStatus,
  projectCodexTaskBucket,
  projectCodexTaskId,
  projectCodexTaskPrimaryAction,
  projectCodexTasks,
  type ProjectCodexTask,
  type ProjectCodexTaskBucket,
  type ProjectCodexTaskMachineGroup
} from './project-codex-task-model';
import type { CodexThreadOrigin } from './codex-sessions-types';

function attentionByTaskId(
  conversations: ReturnType<CodexSessionsController['getState']>['conversations']
) {
  const result: Record<string, 'waiting-approval' | 'waiting-input'> = {};
  for (const conversation of conversations) {
    const id = projectCodexTaskId(conversation.machineId, conversation.threadId);
    if ((conversation.approvals?.length ?? 0) > 0) result[id] = 'waiting-approval';
    else if ((conversation.userInputRequests?.length ?? 0) > 0) result[id] = 'waiting-input';
  }
  return result;
}

function TaskStatus({ group, task }: { group: ProjectCodexTaskMachineGroup; task: ProjectCodexTask }) {
  const status = presentProjectCodexTaskStatus(
    task.status,
    group.connectorStatuses[task.machineId] ?? 'unavailable'
  );
  if (status.loading) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[10px] text-emerald-300">
        <Spinner color="success" size="sm" /> Running
      </span>
    );
  }
  return (
    <span className={cn(
      'inline-flex items-center gap-1.5 text-[10px] text-neutral-500',
      (status.status === 'waiting-approval' || status.status === 'waiting-input') && 'text-amber-300',
      (status.status === 'offline' || status.status === 'missing' || status.status === 'unavailable') && 'text-red-300/80'
    )}>
      <Circle className="size-1.5 fill-current" /> {status.label}
    </span>
  );
}

const taskBucketLabels: Record<ProjectCodexTaskBucket, { description: string; label: string }> = {
  running: { description: 'Turns producing live activity now', label: 'Running' },
  attention: { description: 'Approval, input, failure, or recovery required', label: 'Needs attention' },
  ready: { description: 'Resumable conversations with no active turn', label: 'Ready / idle' },
  history: { description: 'Offline, stale, archived, and unavailable tasks', label: 'Offline / historical' }
};

function relativeAge(value: string | undefined, now: Date) {
  if (!value) return 'unknown';
  const elapsed = Math.max(0, now.getTime() - Date.parse(value));
  if (!Number.isFinite(elapsed)) return 'unknown';
  if (elapsed < 5_000) return 'now';
  if (elapsed < 60_000) return `${Math.floor(elapsed / 1_000)}s ago`;
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return `${Math.floor(elapsed / 86_400_000)}d ago`;
}

function elapsedTime(value: string | undefined, now: Date) {
  if (!value) return 'Starting';
  const elapsed = Math.max(0, now.getTime() - Date.parse(value));
  if (!Number.isFinite(elapsed)) return 'Starting';
  const seconds = Math.floor(elapsed / 1_000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return hours > 0
    ? `${hours}h ${minutes % 60}m`
    : minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function TaskRow({
  group,
  now,
  onOpenTask,
  task
}: {
  group: ProjectCodexTaskMachineGroup;
  now: Date;
  onOpenTask(origin: CodexThreadOrigin): void;
  task: ProjectCodexTask;
}) {
  const machineStatus = group.connectorStatuses[task.machineId] ?? 'unavailable';
  const action = projectCodexTaskPrimaryAction(task, machineStatus);
  const snapshot = task.activity;
  const running = projectCodexTaskBucket(task, machineStatus) === 'running';
  const stale = snapshot?.freshness === 'stale';
  const repository = task.taskIdentity?.repository ?? task.projectName ?? 'Repository not reported';
  const branch = task.taskIdentity?.branch ?? task.cwd?.split(/[\\/]/).filter(Boolean).at(-1);
  const machine = task.taskIdentity?.codespaceName ?? group.machine.name;
  return (
    <article
      className={cn(
        'relative grid gap-3 border-b border-neutral-900 px-4 py-4 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center',
        running && 'bg-emerald-500/[0.035] before:absolute before:inset-y-3 before:left-0 before:w-0.5 before:rounded-full before:bg-emerald-400'
      )}
      data-codex-task-bucket={projectCodexTaskBucket(task, machineStatus)}
      data-codex-task-id={task.id}
    >
      <div className="min-w-0">
        <div className="flex min-w-0 items-start gap-3">
          <div className={cn(
            'mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-neutral-900 text-neutral-500',
            running && 'bg-emerald-500/10 text-emerald-300',
            (task.status === 'waiting-approval' || task.status === 'waiting-input') && 'bg-amber-500/10 text-amber-300'
          )}>
            {running ? <Activity className="size-3.5 animate-pulse" />
              : task.status === 'waiting-approval' || task.status === 'waiting-input'
                ? <AlertTriangle className="size-3.5" />
                : machineStatus === 'connected' ? <CheckCircle2 className="size-3.5" /> : <WifiOff className="size-3.5" />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              {task.issueNumber ? <Text className="shrink-0 text-[10px] font-semibold text-neutral-500">Issue #{task.issueNumber}</Text> : null}
              <Text as="h3" className="block min-w-0 truncate text-sm font-semibold text-neutral-100">{task.title}</Text>
              <TaskStatus group={group} task={task} />
            </div>
            <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-neutral-500">
              <span className="inline-flex min-w-0 items-center gap-1.5" title={task.taskIdentity?.worktree ?? task.cwd}>
                <GitBranch className="size-3 shrink-0" />
                <span className="max-w-64 truncate">{repository}{branch ? ` · ${branch}` : ''}</span>
              </span>
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <Server className="size-3 shrink-0" />
                <span className="max-w-52 truncate">{machine}</span>
              </span>
            </div>
            <div className="mt-3 grid gap-1.5 text-[10px] text-neutral-500 sm:grid-cols-2 xl:grid-cols-4">
              <span className="min-w-0 truncate text-neutral-300">{snapshot?.currentPhase ?? 'Task state unavailable'}</span>
              <span className="inline-flex items-center gap-1.5"><Clock3 className="size-3" />{running ? elapsedTime(snapshot?.currentTurnStartedAt, now) : `Activity ${relativeAge(snapshot?.lastEventAt ?? task.lastActivityAt, now)}`}</span>
              <span className="min-w-0 truncate">{snapshot?.latestMilestone ?? snapshot?.latestActivity ?? 'No recent milestone'}</span>
              <span className={cn('inline-flex items-center gap-1.5', stale ? 'text-amber-300' : 'text-emerald-400/80')}>
                <Radio className="size-3" />
                {stale ? `Last known · ${relativeAge(snapshot?.lastSuccessfulRefreshAt, now)}` : `Live · refreshed ${relativeAge(snapshot?.lastSuccessfulRefreshAt, now)}`}
              </span>
            </div>
          </div>
        </div>
      </div>
      <Button
        className="justify-self-start rounded-full sm:justify-self-end"
        onPress={() => onOpenTask({ machineId: task.machineId, threadId: task.threadId })}
        size="sm"
        variant={action === 'Resolve problem' ? 'outline' : running ? 'primary' : 'ghost'}
      >
        {action}
      </Button>
    </article>
  );
}

function ActivityGroup({
  bucket,
  entries,
  now,
  onOpenTask
}: {
  bucket: ProjectCodexTaskBucket;
  entries: Array<{ group: ProjectCodexTaskMachineGroup; task: ProjectCodexTask }>;
  now: Date;
  onOpenTask(origin: CodexThreadOrigin): void;
}) {
  if (entries.length === 0) return null;
  const content = entries.map(({ group, task }) => (
    <TaskRow group={group} key={task.id} now={now} onOpenTask={onOpenTask} task={task} />
  ));
  if (bucket === 'history') {
    return (
      <details className="group/history border-t border-neutral-800/80">
        <summary className="flex min-h-14 cursor-pointer list-none items-center gap-3 px-4 outline-none hover:bg-neutral-900/40 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-neutral-500 [&::-webkit-details-marker]:hidden">
          <History className="size-4 text-neutral-600" />
          <div className="min-w-0 flex-1">
            <Text className="block text-xs font-semibold text-neutral-300">{taskBucketLabels[bucket].label}</Text>
            <Text className="mt-0.5 block text-[10px] text-neutral-600">{taskBucketLabels[bucket].description}</Text>
          </div>
          <Chip className="text-neutral-500" size="sm">{entries.length}</Chip>
        </summary>
        <div>{content}</div>
      </details>
    );
  }
  return (
    <section aria-label={taskBucketLabels[bucket].label}>
      <header className="flex min-h-12 items-center gap-3 border-b border-neutral-900 bg-neutral-950/70 px-4">
        <div className="min-w-0 flex-1">
          <Text className="block text-xs font-semibold text-neutral-300">{taskBucketLabels[bucket].label}</Text>
          <Text className="mt-0.5 block text-[10px] text-neutral-600">{taskBucketLabels[bucket].description}</Text>
        </div>
        <Chip className="text-neutral-500" size="sm">{entries.length}</Chip>
      </header>
      <div>{content}</div>
    </section>
  );
}

function TaskGroups({
  groups,
  now,
  noTasksLabel = 'No Codex tasks on this machine',
  onManageConnector,
  onOpenTask,
  overallTruth,
  truthByConnectorId
}: {
  groups: ProjectCodexTaskMachineGroup[];
  now: Date;
  noTasksLabel?: string;
  onManageConnector?(machineId: string): void;
  onOpenTask(origin: CodexThreadOrigin): void;
  overallTruth: CodexInventoryTruth;
  truthByConnectorId: ReadonlyMap<string, CodexInventoryTruth>;
}) {
  if (groups.length === 0) {
    const ready = overallTruth.state === 'ready';
    const checking = overallTruth.state === 'checking'
      || overallTruth.state === 'updating'
      || overallTruth.state === 'restarting';
    return (
      <div className="grid min-h-52 place-items-center px-6 text-center">
        <div>
          {ready
            ? <Bot className="mx-auto size-5 text-neutral-700" />
            : checking
              ? <Spinner size="sm" />
              : <MonitorOff className="mx-auto size-5 text-red-300/70" />}
          <Text className="mt-3 block text-sm font-medium text-neutral-300">
            {ready ? 'No matching Codex tasks' : overallTruth.label}
          </Text>
          <Text className="mt-1 block text-[11px] leading-5 text-neutral-600">
            {ready
              ? 'Compatible connectors reported no tasks inside this project.'
              : overallTruth.detail}
          </Text>
        </div>
      </div>
    );
  }
  const entries = groups.flatMap((group) => group.tasks.map((task) => ({ group, task })));
  const buckets = new Map<ProjectCodexTaskBucket, typeof entries>();
  for (const bucket of ['running', 'attention', 'ready', 'history'] as const) buckets.set(bucket, []);
  for (const entry of entries) {
    const machineStatus = entry.group.connectorStatuses[entry.task.machineId] ?? 'unavailable';
    buckets.get(projectCodexTaskBucket(entry.task, machineStatus))!.push(entry);
  }
  const taskGroupWarnings = groups.flatMap((group) => {
    if (group.tasks.length === 0) return [];
    const truth = aggregateCodexInventoryTruth(group.connectorIds.map((connectorId) => (
      truthByConnectorId.get(connectorId)
      ?? codexInventoryTruth({ inventory: group.machine })
    )));
    return truth.state === 'ready' ? [] : [{ group, truth }];
  });
  return (
    <div>
      {taskGroupWarnings.map(({ group, truth }) => (
        <section className="border-b border-amber-500/10 bg-amber-500/[0.025] px-4 py-3" key={`warning:${group.machine.id}`}>
          <Text className="block text-[10px] font-semibold text-amber-300/90">{group.machine.name} · {truth.label}</Text>
          <Text className="mt-1 block text-[10px] leading-5 text-neutral-500">{truth.detail}</Text>
        </section>
      ))}
      {(['running', 'attention', 'ready', 'history'] as const).map((bucket) => (
        <ActivityGroup
          bucket={bucket}
          entries={buckets.get(bucket) ?? []}
          key={bucket}
          now={now}
          onOpenTask={onOpenTask}
        />
      ))}
      {groups.filter((group) => group.tasks.length === 0).map((group) => {
        const groupTruth = aggregateCodexInventoryTruth(
          group.connectorIds.map((connectorId) => (
            truthByConnectorId.get(connectorId)
            ?? codexInventoryTruth({ inventory: group.machine })
          ))
        );
        const manageConnectorId = group.connectorIds.find((connectorId) => (
          truthByConnectorId.get(connectorId)?.state === groupTruth.state
        )) ?? group.connectorIds.find((connectorId) => (
          truthByConnectorId.get(connectorId)?.state !== 'ready'
        ));
        const checking = groupTruth.state === 'checking';
        const machineLabel = checking && group.machine.name === 'Unavailable connector'
          ? 'Checking machine'
          : group.machine.name;
        return (
        <section aria-label={`${machineLabel} Codex tasks`} className="border-t border-neutral-800/70" key={group.machine.id}>
          <header className="flex h-10 items-center gap-2 bg-neutral-950/70 px-3 text-[10px] text-neutral-500">
            {checking ? (
              <Spinner size="sm" />
            ) : groupTruth.state === 'ready' ? (
              <span className="size-1.5 rounded-full bg-emerald-400" />
            ) : (
              <MonitorOff className="size-3 text-red-300/70" />
            )}
            <Text className="truncate font-medium text-neutral-300">{machineLabel}</Text>
            <Text className={cn(
              'capitalize',
              groupTruth.state === 'ready'
                ? 'text-emerald-300/80'
                : checking
                  ? 'text-neutral-400'
                  : groupTruth.state === 'update-required'
                    ? 'text-amber-300/80'
                    : groupTruth.state === 'updating' || groupTruth.state === 'restarting'
                      ? 'text-sky-300/80'
                      : 'text-red-300/80'
            )}>
              {groupTruth.label}
            </Text>
            {groupTruth.state === 'ready' || group.tasks.length > 0 ? (
              <Text className="ml-auto">{group.tasks.length}</Text>
            ) : null}
          </header>
          <div className="divide-y divide-neutral-900">
            {groupTruth.state !== 'ready' ? (
              <Text className="block px-3 py-4 text-[11px] text-neutral-600">
                {groupTruth.detail}
              </Text>
            ) : group.tasks.length === 0 ? (
              <Text className="block px-3 py-4 text-[11px] text-neutral-600">
                {noTasksLabel}
              </Text>
            ) : null}
            {groupTruth.state !== 'ready' && onManageConnector && manageConnectorId ? (
              <div className="px-3 pb-3">
                <Button
                  onPress={() => onManageConnector(manageConnectorId)}
                  size="sm"
                  variant="ghost"
                >
                  Manage connector
                </Button>
              </div>
            ) : null}
          </div>
        </section>
        );
      })}
    </div>
  );
}

function ProjectTaskPanel({
  freshnessFilter,
  groups,
  loading,
  noTasksLabel,
  onManageConnector,
  onOpenTask,
  overallTruth,
  now,
  query,
  setFreshnessFilter,
  setQuery,
  setStateFilter,
  stateFilter,
  truthByConnectorId
}: {
  freshnessFilter: 'all' | 'live' | 'stale';
  groups: ProjectCodexTaskMachineGroup[];
  loading: boolean;
  noTasksLabel: string;
  onManageConnector?(machineId: string): void;
  onOpenTask(origin: CodexThreadOrigin): void;
  overallTruth: CodexInventoryTruth;
  now: Date;
  query: string;
  setFreshnessFilter(value: 'all' | 'live' | 'stale'): void;
  setQuery(value: string): void;
  setStateFilter(value: 'all' | ProjectCodexTaskBucket): void;
  stateFilter: 'all' | ProjectCodexTaskBucket;
  truthByConnectorId: ReadonlyMap<string, CodexInventoryTruth>;
}) {
  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-neutral-800/80 bg-neutral-950/40">
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-neutral-800/80 px-4 py-3">
        <div className="min-w-0 flex-1">
          <Text as="h2" className="block text-sm font-semibold text-neutral-100">Codex tasks</Text>
          <Text className="mt-0.5 block text-[10px] text-neutral-500">Live work first, with exact task and machine evidence</Text>
        </div>
        {loading ? <Spinner size="sm" /> : null}
        <SearchField className="w-full sm:w-60" onChange={setQuery} value={query}>
          <SearchFieldGroup className="flex h-8 items-center gap-2 rounded-lg border border-neutral-800 bg-neutral-950 px-2">
            <SearchFieldSearchIcon />
            <SearchFieldInput className="min-w-0 flex-1 bg-transparent text-xs outline-none" placeholder="Search tasks" />
            <SearchFieldClearButton />
          </SearchFieldGroup>
        </SearchField>
        <select
          aria-label="Filter Codex tasks by state"
          className="h-8 rounded-lg border border-neutral-800 bg-neutral-950 px-2 text-[10px] text-neutral-300 outline-none focus:border-neutral-600"
          onChange={(event) => setStateFilter(event.target.value as 'all' | ProjectCodexTaskBucket)}
          value={stateFilter}
        >
          <option value="all">All states</option>
          <option value="running">Running</option>
          <option value="attention">Needs attention</option>
          <option value="ready">Ready / idle</option>
          <option value="history">Offline / historical</option>
        </select>
        <select
          aria-label="Filter Codex tasks by freshness"
          className="h-8 rounded-lg border border-neutral-800 bg-neutral-950 px-2 text-[10px] text-neutral-300 outline-none focus:border-neutral-600"
          onChange={(event) => setFreshnessFilter(event.target.value as 'all' | 'live' | 'stale')}
          value={freshnessFilter}
        >
          <option value="all">All evidence</option>
          <option value="live">Live</option>
          <option value="stale">Stale / last known</option>
        </select>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <TaskGroups
          groups={groups}
          now={now}
          noTasksLabel={noTasksLabel}
          onManageConnector={onManageConnector}
          onOpenTask={onOpenTask}
          overallTruth={overallTruth}
          truthByConnectorId={truthByConnectorId}
        />
      </div>
    </section>
  );
}

export function ProjectCodexTasks({
  connectorOverview,
  controller,
  isConnectorRefreshing = false,
  machineIds,
  mode,
  now: suppliedNow,
  onManageConnector,
  onOpenTask,
  projectRecords
}: {
  connectorOverview?: ConnectorOverviewResult;
  controller: CodexSessionsController;
  isConnectorRefreshing?: boolean;
  machineIds: string[];
  mode: 'panel' | 'preview';
  now?: Date;
  onManageConnector?(machineId: string): void;
  onOpenTask(origin: CodexThreadOrigin): void;
  projectRecords: ProjectSpaceRecord[];
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  const [query, setQuery] = useState('');
  const [stateFilter, setStateFilter] = useState<'all' | ProjectCodexTaskBucket>('all');
  const [freshnessFilter, setFreshnessFilter] = useState<'all' | 'live' | 'stale'>('all');
  const [inventoryObservedAt, setInventoryObservedAt] = useState(() => suppliedNow ?? new Date());
  const now = suppliedNow ?? inventoryObservedAt;
  const machineKey = machineIds.join('\u0000');
  const connectorInstanceIds = useMemo(() => Object.fromEntries(
    (connectorOverview?.machines ?? []).map((machine) => [
      machine.id,
      machine.connector.runtime?.instanceId
    ])
  ), [connectorOverview?.machines]);

  useEffect(() => {
    let active = true;
    let refreshing = false;
    const refresh = async () => {
      if (active && !suppliedNow) setInventoryObservedAt(new Date());
      if (refreshing || (typeof document !== 'undefined' && document.hidden)) return;
      refreshing = true;
      try {
        await controller.loadMachines(machineIds, connectorInstanceIds);
      } finally {
        refreshing = false;
        if (active && !suppliedNow) setInventoryObservedAt(new Date());
      }
    };
    void refresh();
    const interval = setInterval(() => void refresh(), 5_000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [connectorInstanceIds, controller, machineKey, suppliedNow]);

  const tasks = useMemo(() => projectCodexTasks(
    state.sessions,
    projectRecords,
    attentionByTaskId(state.conversations)
  ), [projectRecords, state.conversations, state.sessions]);
  const visibleTasks = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const machineById = new Map(state.machines.map((machine) => [machine.id, machine]));
    return tasks.filter((task) => {
      const machine = machineById.get(task.machineId);
      const bucket = projectCodexTaskBucket(task, machine?.status ?? 'unavailable');
      if (stateFilter !== 'all' && bucket !== stateFilter) return false;
      if (freshnessFilter !== 'all' && (task.activity?.freshness ?? 'unknown') !== freshnessFilter) return false;
      if (!normalized) return true;
      return [
        task.title,
        task.issueNumber ? `issue ${task.issueNumber} #${task.issueNumber}` : undefined,
        task.taskIdentity?.repository,
        task.taskIdentity?.branch,
        task.taskIdentity?.worktree,
        task.cwd,
        machine?.name,
        task.status,
        task.activity?.freshness,
        task.activity?.currentPhase
      ].filter(Boolean).join(' ').toLocaleLowerCase().includes(normalized);
    });
  }, [freshnessFilter, query, state.machines, stateFilter, tasks]);
  const groups = useMemo(
    () => groupProjectCodexTasks(
      visibleTasks,
      state.machines,
      projectRecords.flatMap((record) => record.machineId ? [record.machineId] : []),
      {
        connectors: connectorOverview?.machines,
        physicalMachines: connectorOverview?.physicalMachines
      }
    ),
    [
      connectorOverview?.machines,
      connectorOverview?.physicalMachines,
      projectRecords,
      state.machines,
      visibleTasks
    ]
  );
  const activeTaskCount = useMemo(
    () => countActiveProjectCodexTasks(tasks, groups),
    [groups, tasks]
  );
  const inventoryByMachineId = useMemo(
    () => new Map(state.machines.map((machine) => [machine.id, machine])),
    [state.machines]
  );
  const scopedConnectorIds = useMemo(() => [...new Set(
    projectRecords.flatMap((record) => record.machineId ? [record.machineId] : [])
  )], [projectRecords]);
  const truthByConnectorId = useMemo(() => new Map(scopedConnectorIds.map((machineId) => {
    const connector = connectorOverview?.machines.find((machine) => machine.id === machineId);
    return [machineId, codexInventoryTruth({
      connector,
      connectorRequired: connectorOverview !== undefined,
      inventory: inventoryByMachineId.get(machineId),
      loading: state.loadingMachineIds.includes(machineId),
      now,
      overviewRefreshing: isConnectorRefreshing,
      runtime: state.runtimeByMachineId?.[machineId]
    })];
  })), [
    connectorOverview?.machines,
    inventoryByMachineId,
    isConnectorRefreshing,
    now,
    scopedConnectorIds,
    state.loadingMachineIds,
    state.runtimeByMachineId
  ]);
  const overallTruth = useMemo(
    () => aggregateCodexInventoryTruth(
      truthByConnectorId.size > 0
        ? [...truthByConnectorId.values()]
        : [codexInventoryTruth({
            connectorRequired: true,
            overviewRefreshing: isConnectorRefreshing
          })]
    ),
    [isConnectorRefreshing, truthByConnectorId]
  );
  const loading = state.loadingMachineIds.length > 0;

  if (mode === 'panel') {
    return (
      <ProjectTaskPanel
        freshnessFilter={freshnessFilter}
        groups={groups}
        loading={loading}
        noTasksLabel={query.trim() ? 'No matching tasks on this machine' : 'No Codex tasks on this machine'}
        onManageConnector={onManageConnector}
        onOpenTask={onOpenTask}
        now={now}
        overallTruth={overallTruth}
        query={query}
        setFreshnessFilter={setFreshnessFilter}
        setQuery={setQuery}
        setStateFilter={setStateFilter}
        stateFilter={stateFilter}
        truthByConnectorId={truthByConnectorId}
      />
    );
  }

  return (
    <Drawer>
      <Drawer.Trigger className="inline-flex h-8 items-center gap-2 rounded-full border border-neutral-800 bg-neutral-900/70 px-3 text-[10px] font-medium text-neutral-300 transition hover:border-neutral-700 hover:bg-neutral-800">
        {loading ? <Spinner size="sm" /> : <Bot className="size-3.5" />}
        {overallTruth.state === 'ready'
          ? `${activeTaskCount} active ${activeTaskCount === 1 ? 'task' : 'tasks'}`
          : `${overallTruth.label} Codex`}
      </Drawer.Trigger>
      <Drawer.Backdrop className="fixed inset-0 z-[90] bg-black/65 backdrop-blur-[1px]">
        <Drawer.Content className="fixed inset-y-0 right-0 w-[min(25rem,94vw)] border-l border-neutral-800 bg-neutral-950 shadow-2xl shadow-black" placement="right">
          <Drawer.Dialog className="flex size-full min-h-0 flex-col outline-none">
            <Drawer.Header className="flex h-[68px] shrink-0 items-center gap-3 border-b border-neutral-800 px-4">
              <Bot className="size-4 text-neutral-400" />
              <div className="min-w-0">
                <Drawer.Heading className="text-sm font-semibold text-neutral-100">Codex tasks</Drawer.Heading>
                <Text className="mt-0.5 block text-[10px] text-neutral-500">
                  {overallTruth.state === 'ready'
                    ? `${activeTaskCount} active · grouped by machine and connector`
                    : `${overallTruth.label} · current inventory is not ready`}
                </Text>
              </div>
              <Drawer.CloseTrigger className="ml-auto grid size-8 place-items-center rounded-lg text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100">
                <X className="size-4" />
              </Drawer.CloseTrigger>
            </Drawer.Header>
            <Drawer.Body className="min-h-0 flex-1 overflow-y-auto p-0">
              <TaskGroups
                groups={groups}
                now={now}
                onManageConnector={onManageConnector}
                onOpenTask={onOpenTask}
                overallTruth={overallTruth}
                truthByConnectorId={truthByConnectorId}
              />
            </Drawer.Body>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    </Drawer>
  );
}
