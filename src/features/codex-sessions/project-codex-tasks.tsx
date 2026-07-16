import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Drawer, Spinner } from '@heroui/react';
import {
  Bot,
  ChevronRight,
  Circle,
  GitPullRequest,
  MonitorOff,
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
import type { ProjectSpaceRecord } from '@/shared/project-space-api';
import { cn } from '@/lib/utils';
import type { CodexSessionsController } from './codex-sessions-controller';
import {
  countActiveProjectCodexTasks,
  groupProjectCodexTasks,
  presentProjectCodexTaskStatus,
  projectCodexTaskId,
  projectCodexTasks,
  type ProjectCodexTask,
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
  const status = presentProjectCodexTaskStatus(task.status, group.machine.status);
  if (status.loading) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[10px] text-emerald-300">
        <Spinner color="success" size="sm" /> Active
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

function TaskGroups({
  groups,
  loadingMachineIds = [],
  noTasksLabel = 'No Codex tasks on this machine',
  onOpenTask
}: {
  groups: ProjectCodexTaskMachineGroup[];
  loadingMachineIds?: readonly string[];
  noTasksLabel?: string;
  onOpenTask(origin: CodexThreadOrigin): void;
}) {
  if (groups.length === 0) {
    return (
      <div className="grid min-h-52 place-items-center px-6 text-center">
        <div>
          <Bot className="mx-auto size-5 text-neutral-700" />
          <Text className="mt-3 block text-sm font-medium text-neutral-300">No matching Codex tasks</Text>
          <Text className="mt-1 block text-[11px] leading-5 text-neutral-600">
            Tasks appear after their authenticated machine reports a directory inside this project.
          </Text>
        </div>
      </div>
    );
  }
  return (
    <div className="divide-y divide-neutral-800/70">
      {groups.map((group) => {
        const checking = group.machine.status === 'unavailable'
          && loadingMachineIds.includes(group.machine.id);
        const machineLabel = checking ? 'Checking machine' : group.machine.name;
        return (
        <section aria-label={`${machineLabel} Codex tasks`} key={group.machine.id}>
          <header className="flex h-10 items-center gap-2 bg-neutral-950/70 px-3 text-[10px] text-neutral-500">
            {checking ? (
              <Spinner size="sm" />
            ) : group.machine.status === 'connected' ? (
              <span className="size-1.5 rounded-full bg-emerald-400" />
            ) : (
              <MonitorOff className="size-3 text-red-300/70" />
            )}
            <Text className="truncate font-medium text-neutral-300">{machineLabel}</Text>
            <Text className={cn(
              'capitalize',
              checking
                ? 'text-neutral-400'
                : group.machine.status === 'connected'
                  ? 'text-emerald-300/80'
                  : 'text-red-300/80'
            )}>
              {checking ? 'Checking' : group.machine.status}
            </Text>
            <Text className="ml-auto">{group.tasks.length}</Text>
          </header>
          <div className="divide-y divide-neutral-900">
            {group.tasks.length === 0 ? (
              <Text className="block px-3 py-4 text-[11px] text-neutral-600">
                {checking ? 'Checking for Codex tasks' : noTasksLabel}
              </Text>
            ) : null}
            {group.tasks.map((task) => (
              <button
                className="group flex w-full min-w-0 items-center gap-3 px-3 py-3 text-left transition hover:bg-neutral-900/65 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-neutral-500"
                key={task.id}
                onClick={() => onOpenTask({ machineId: task.machineId, threadId: task.threadId })}
                type="button"
              >
                <div className="min-w-0 flex-1">
                  <Text className="block truncate text-xs font-medium text-neutral-100">{task.title}</Text>
                  <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-2">
                    <TaskStatus group={group} task={task} />
                    {task.issueNumber ? (
                      <Chip className="text-[9px] text-neutral-500" size="sm">Issue #{task.issueNumber}</Chip>
                    ) : null}
                    {task.pullRequestNumber ? (
                      <Chip className="gap-1 text-[9px] text-neutral-500" size="sm">
                        <GitPullRequest className="size-2.5" /> PR #{task.pullRequestNumber}
                      </Chip>
                    ) : null}
                  </div>
                </div>
                <ChevronRight className="size-3.5 shrink-0 text-neutral-700 transition group-hover:text-neutral-400" />
              </button>
            ))}
          </div>
        </section>
        );
      })}
    </div>
  );
}

function ProjectTaskPanel({
  groups,
  loading,
  loadingMachineIds,
  noTasksLabel,
  onOpenTask,
  query,
  setQuery
}: {
  groups: ProjectCodexTaskMachineGroup[];
  loading: boolean;
  loadingMachineIds: readonly string[];
  noTasksLabel: string;
  onOpenTask(origin: CodexThreadOrigin): void;
  query: string;
  setQuery(value: string): void;
}) {
  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-neutral-800/80 bg-neutral-950/40">
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-neutral-800/80 px-4 py-3">
        <div className="min-w-0 flex-1">
          <Text as="h2" className="block text-sm font-semibold text-neutral-100">Codex tasks</Text>
          <Text className="mt-0.5 block text-[10px] text-neutral-500">Grouped by the machine that owns each task</Text>
        </div>
        {loading ? <Spinner size="sm" /> : null}
        <SearchField className="w-full sm:w-60" onChange={setQuery} value={query}>
          <SearchFieldGroup className="flex h-8 items-center gap-2 rounded-lg border border-neutral-800 bg-neutral-950 px-2">
            <SearchFieldSearchIcon />
            <SearchFieldInput className="min-w-0 flex-1 bg-transparent text-xs outline-none" placeholder="Search tasks" />
            <SearchFieldClearButton />
          </SearchFieldGroup>
        </SearchField>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <TaskGroups
          groups={groups}
          loadingMachineIds={loadingMachineIds}
          noTasksLabel={noTasksLabel}
          onOpenTask={onOpenTask}
        />
      </div>
    </section>
  );
}

export function ProjectCodexTasks({
  controller,
  machineIds,
  mode,
  onOpenTask,
  projectRecords
}: {
  controller: CodexSessionsController;
  machineIds: string[];
  mode: 'panel' | 'preview';
  onOpenTask(origin: CodexThreadOrigin): void;
  projectRecords: ProjectSpaceRecord[];
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  const [query, setQuery] = useState('');
  const machineKey = machineIds.join('\u0000');

  useEffect(() => {
    let refreshing = false;
    const refresh = async () => {
      if (refreshing || (typeof document !== 'undefined' && document.hidden)) return;
      refreshing = true;
      try {
        await controller.loadMachines(machineIds);
      } finally {
        refreshing = false;
      }
    };
    void refresh();
    const interval = setInterval(() => void refresh(), 5_000);
    return () => clearInterval(interval);
  }, [controller, machineKey]);

  const tasks = useMemo(() => projectCodexTasks(
    state.sessions,
    projectRecords,
    attentionByTaskId(state.conversations)
  ), [projectRecords, state.conversations, state.sessions]);
  const visibleTasks = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return normalized
      ? tasks.filter((task) => task.title.toLocaleLowerCase().includes(normalized))
      : tasks;
  }, [query, tasks]);
  const groups = useMemo(
    () => groupProjectCodexTasks(
      visibleTasks,
      state.machines,
      projectRecords.flatMap((record) => record.machineId ? [record.machineId] : [])
    ),
    [projectRecords, state.machines, visibleTasks]
  );
  const activeTaskCount = useMemo(
    () => countActiveProjectCodexTasks(tasks, groups),
    [groups, tasks]
  );
  const loading = state.loadingMachineIds.length > 0;

  if (mode === 'panel') {
    return (
      <ProjectTaskPanel
        groups={groups}
        loading={loading}
        loadingMachineIds={state.loadingMachineIds}
        noTasksLabel={query.trim() ? 'No matching tasks on this machine' : 'No Codex tasks on this machine'}
        onOpenTask={onOpenTask}
        query={query}
        setQuery={setQuery}
      />
    );
  }

  return (
    <Drawer>
      <Drawer.Trigger className="inline-flex h-8 items-center gap-2 rounded-full border border-neutral-800 bg-neutral-900/70 px-3 text-[10px] font-medium text-neutral-300 transition hover:border-neutral-700 hover:bg-neutral-800">
        {loading ? <Spinner size="sm" /> : <Bot className="size-3.5" />}
        {activeTaskCount} active {activeTaskCount === 1 ? 'task' : 'tasks'}
      </Drawer.Trigger>
      <Drawer.Backdrop className="fixed inset-0 z-[90] bg-black/65 backdrop-blur-[1px]">
        <Drawer.Content className="fixed inset-y-0 right-0 w-[min(25rem,94vw)] border-l border-neutral-800 bg-neutral-950 shadow-2xl shadow-black" placement="right">
          <Drawer.Dialog className="flex size-full min-h-0 flex-col outline-none">
            <Drawer.Header className="flex h-[68px] shrink-0 items-center gap-3 border-b border-neutral-800 px-4">
              <Bot className="size-4 text-neutral-400" />
              <div className="min-w-0">
                <Drawer.Heading className="text-sm font-semibold text-neutral-100">Codex tasks</Drawer.Heading>
                <Text className="mt-0.5 block text-[10px] text-neutral-500">
                  {activeTaskCount} active · grouped by owning machine
                </Text>
              </div>
              <Drawer.CloseTrigger className="ml-auto grid size-8 place-items-center rounded-lg text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100">
                <X className="size-4" />
              </Drawer.CloseTrigger>
            </Drawer.Header>
            <Drawer.Body className="min-h-0 flex-1 overflow-y-auto p-0">
              <TaskGroups
                groups={groups}
                loadingMachineIds={state.loadingMachineIds}
                onOpenTask={onOpenTask}
              />
            </Drawer.Body>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    </Drawer>
  );
}
