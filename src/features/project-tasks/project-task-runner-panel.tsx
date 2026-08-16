import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { Bot, GitBranch, LoaderCircle, Monitor, Radio } from 'lucide-react';
import { Button, Chip, Text } from '@/app/dotnaos-ui';
import { ProjectChatAgentAvatar } from '@/features/project-chat/components/project-chat-agent-avatar';
import type { ProjectSpaceRecord } from '@/shared/project-space-api';
import { codexAgentIdentity } from '../codex-sessions/codex-agent-identity';
import type { CodexSessionsController } from '../codex-sessions/codex-sessions-controller';
import { useCodexSessionsInventory } from '../codex-sessions/codex-sessions-inventory-context';
import {
  presentProjectCodexTaskStatus,
  type ProjectCodexTask
} from '../codex-sessions/project-codex-task-model';
import { formatCodexActivity } from '../codex-sessions/codex-sessions-model';
import type { CodexMachine, CodexThreadOrigin } from '../codex-sessions/codex-sessions-types';
import { codexTasksForIssue } from './project-task-runtime-model';

function statusColor(status: ReturnType<typeof presentProjectCodexTaskStatus>['status']) {
  if (status === 'active') return 'success' as const;
  if (status === 'waiting-approval' || status === 'waiting-input') return 'warning' as const;
  if (status === 'offline' || status === 'missing' || status === 'unavailable') return 'danger' as const;
  return 'default' as const;
}

function TaskRunnerRow({
  machine,
  onOpen,
  task
}: {
  machine?: CodexMachine;
  onOpen(origin: CodexThreadOrigin): void;
  task: ProjectCodexTask;
}) {
  const status = presentProjectCodexTaskStatus(task.status, machine?.status ?? 'unavailable');
  const agent = codexAgentIdentity(task.rawTitle);
  const branch = task.taskIdentity?.branch
    ?? task.taskIdentity?.worktree
    ?? task.cwd?.split(/[\\/]/).filter(Boolean).at(-1)
    ?? 'Worktree unavailable';
  const machineName = task.taskIdentity?.codespaceName ?? machine?.name ?? task.machineId;

  return (
    <article className="grid gap-3 border-b border-current/[.08] py-4 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="flex min-w-0 items-start gap-3">
        <ProjectChatAgentAvatar category={agent.category} name={agent.name} size={32} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Text as="h3" className="min-w-0 truncate text-sm font-semibold text-neutral-100">
              {task.title}
            </Text>
            <Chip color={statusColor(status.status)} size="sm" variant="soft">
              {status.loading ? <LoaderCircle aria-hidden className="size-3 animate-spin" /> : null}
              {status.label}
            </Chip>
          </div>
          <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-xs text-current/45">
            <span className="inline-flex min-w-0 items-center gap-1.5" title={task.taskIdentity?.worktree ?? task.cwd}>
              <GitBranch aria-hidden className="size-3.5 shrink-0" />
              <span className="max-w-72 truncate">{branch}</span>
            </span>
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <Monitor aria-hidden className="size-3.5 shrink-0" />
              <span className="max-w-44 truncate">{machineName}</span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Radio aria-hidden className="size-3.5" />
              {formatCodexActivity(task.activity?.lastEventAt ?? task.lastActivityAt)}
            </span>
          </div>
          {task.activity?.currentPhase ? (
            <p className="mt-2 truncate text-xs text-current/60">{task.activity.currentPhase}</p>
          ) : null}
        </div>
      </div>
      <Button
        className="w-full sm:w-auto"
        onPress={() => onOpen({ machineId: task.machineId, threadId: task.threadId })}
        size="sm"
        variant="secondary"
      >
        Open task
      </Button>
    </article>
  );
}

function ConnectedProjectTaskRunnerPanel({
  controller,
  issueNumber,
  machineIds,
  onNewTask,
  onOpenTask,
  project
}: {
  controller: CodexSessionsController;
  issueNumber: number;
  machineIds: string[];
  onNewTask(): void;
  onOpenTask(origin: CodexThreadOrigin): void;
  project: ProjectSpaceRecord;
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  const machineKey = machineIds.join('\u0000');

  useEffect(() => {
    if (machineIds.length === 0) return;
    let refreshing = false;
    const refresh = async () => {
      if (refreshing || document.hidden) return;
      refreshing = true;
      try { await controller.loadMachines(machineIds); } finally { refreshing = false; }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(interval);
  }, [controller, machineKey]);

  const tasks = useMemo(() => codexTasksForIssue({
    issueNumber,
    project,
    sessions: state.sessions
  }), [issueNumber, project, state.sessions]);
  const machines = useMemo(
    () => new Map(state.machines.map((machine) => [machine.id, machine])),
    [state.machines]
  );

  return (
    <section aria-label="Codex tasks for this issue" className="py-4">
      <div className="flex flex-wrap items-center justify-between gap-3 pb-2">
        <div>
          <h2 className="text-sm font-semibold text-current/85">Codex tasks</h2>
          <p className="mt-1 text-xs text-current/40">
            {tasks.length === 0 ? 'No task is linked to this issue yet.' : `${tasks.length} linked ${tasks.length === 1 ? 'task' : 'tasks'}`}
          </p>
        </div>
        <Button onPress={onNewTask} size="sm" variant="secondary">
          <Bot aria-hidden className="size-4" /> New task
        </Button>
      </div>
      {tasks.length > 0 ? (
        <div>
          {tasks.map((task) => (
            <TaskRunnerRow
              key={task.id}
              machine={machines.get(task.machineId)}
              onOpen={onOpenTask}
              task={task}
            />
          ))}
        </div>
      ) : (
        <div className="flex min-h-28 items-center justify-center border-y border-current/[.08] text-center">
          <p className="max-w-sm text-sm leading-6 text-current/40">
            Create a Codex task to work on this issue in a ready Project worktree.
          </p>
        </div>
      )}
    </section>
  );
}

export function ProjectTaskRunnerPanel({
  issueNumber,
  onNewTask,
  onOpenTask,
  project
}: {
  issueNumber: number;
  onNewTask(): void;
  onOpenTask(origin: CodexThreadOrigin): void;
  project: ProjectSpaceRecord;
}) {
  const inventory = useCodexSessionsInventory();
  if (!inventory) {
    return (
      <section className="py-5 text-sm text-current/40">
        Codex task inventory is unavailable for this project.
      </section>
    );
  }
  return (
    <ConnectedProjectTaskRunnerPanel
      controller={inventory.controller}
      issueNumber={issueNumber}
      machineIds={inventory.machineIds}
      onNewTask={onNewTask}
      onOpenTask={onOpenTask}
      project={project}
    />
  );
}
