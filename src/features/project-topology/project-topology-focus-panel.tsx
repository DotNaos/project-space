import {
  ArrowLeft,
  Bot,
  CircleDot,
  GitBranch,
  MessageSquareText,
  Monitor,
  Network,
  Workflow
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Button, Chip, Surface, Text } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import {
  resolveTopologyTarget
} from './project-topology-navigation';
import type { TopologyFocusTarget } from './project-topology-layout';
import type {
  ProjectTopologySnapshot,
  TopologyInventoryResult,
  TopologyMachine,
  TopologyProject
} from './project-topology-types';
import {
  topologyMachineTaskArea,
  topologyTaskStatuses,
  topologyTruthStatus
} from './project-topology-view-model';

export interface ProjectTopologyFocusPanelProps {
  hasBottomTabBar?: boolean;
  onFocusMachine(projectId: string, machineId: string): void;
  onFocusOverview(): void;
  onFocusProject(projectId: string): void;
  onOpenIssue(projectId: string, issueNumber: number): void;
  onOpenProjectConversation(project: TopologyProject): void;
  onOpenTask(taskId: string): void;
  snapshot: ProjectTopologySnapshot;
  target: Extract<TopologyFocusTarget, { kind: 'machine' | 'project' }>;
}

export function ProjectTopologyFocusPanel({
  hasBottomTabBar = false,
  onFocusMachine,
  onFocusOverview,
  onFocusProject,
  onOpenIssue,
  onOpenProjectConversation,
  onOpenTask,
  snapshot,
  target
}: ProjectTopologyFocusPanelProps) {
  const resolved = resolveTopologyTarget(snapshot, target);
  const project = resolved.project;
  if (!project) return null;
  const machines = resolved.machine ? [resolved.machine] : project.machines;
  const status = topologyTruthStatus(resolved.machine?.inventory ?? project.inventory);

  return (
    <Surface
      aria-label={`${resolved.machine?.name ?? project.name} topology details`}
      className={cn(
        'app-no-drag absolute inset-x-2 z-30 flex max-h-[46%] min-h-0 flex-col overflow-hidden rounded-xl border-neutral-700 bg-neutral-950/95 shadow-[0_24px_72px_rgba(0,0,0,0.55)] backdrop-blur sm:inset-x-auto sm:right-3 sm:bottom-3 sm:max-h-[calc(100%-5rem)] sm:w-80',
        hasBottomTabBar
          ? 'bottom-[calc(6.75rem+env(safe-area-inset-bottom))]'
          : 'bottom-2'
      )}
      data-testid="project-topology-focus-panel"
      variant="primary"
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-neutral-800 px-2.5">
        <Button
          aria-label={resolved.machine ? `Back to ${project.name}` : 'Back to portfolio overview'}
          className="size-8 min-h-0"
          isIconOnly
          onPress={resolved.machine
            ? () => onFocusProject(project.id)
            : onFocusOverview}
          size="sm"
          variant="ghost"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
        </Button>
        <span className="min-w-0">
          <Text as="h2" className="block truncate text-xs font-semibold text-neutral-100">
            {resolved.machine?.name ?? project.name}
          </Text>
          <Text className="block truncate text-[11px] text-neutral-400">
            {status.label}{status.detail ? ` · ${status.detail}` : ''}
          </Text>
        </span>
        <Button
          aria-label={`Chat with ${project.name} Project Lead`}
          className="ml-auto size-8 min-h-0"
          isIconOnly
          onPress={() => onOpenProjectConversation(project)}
          size="sm"
          variant="ghost"
        >
          <MessageSquareText aria-hidden="true" className="size-3.5" />
        </Button>
        {resolved.machine ? (
          <Button
            aria-label="Return to portfolio overview"
            className="size-8 min-h-0"
            isIconOnly
            onPress={onFocusOverview}
            size="sm"
            variant="ghost"
          >
            <Network aria-hidden="true" className="size-3.5" />
          </Button>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <InventorySection
          icon={CircleDot}
          label="Issues"
          result={project.issues}
          render={(issues) => issues.map((issue) => (
            <Button
              className="h-auto min-h-8 w-full justify-start gap-2 px-2 py-1.5 text-left"
              key={issue.number}
              onPress={() => onOpenIssue(project.id, issue.number)}
              size="sm"
              variant="ghost"
            >
              <span className="shrink-0 text-xs font-semibold text-neutral-300">
                #{issue.number}
              </span>
              <span className="truncate text-xs text-neutral-400">{issue.title}</span>
              <span className="sr-only">{issue.state}</span>
            </Button>
          ))}
        />

        <InventorySection
          icon={GitBranch}
          label="Branches"
          result={project.branches}
          render={(branches) => (
            <div className="flex flex-wrap gap-1.5">
              {branches.map((branch) => (
                <Chip className="max-w-full" key={branch.name} size="sm">
                  <span className="truncate">{branch.name}</span>
                </Chip>
              ))}
            </div>
          )}
        />

        <section className="mt-4" aria-label="Machines and task ownership">
          <SectionHeading icon={Monitor} label="Machines, worktrees, and tasks" />
          <div className="mt-2 space-y-3">
            {machines.map((machine) => (
              <MachineContext
                key={machine.id}
                machine={machine}
                onFocus={() => onFocusMachine(project.id, machine.id)}
                onOpenTask={onOpenTask}
                projectFocused={!resolved.machine}
              />
            ))}
            {machines.length === 0 ? (
              <EvidenceText truth={project.inventory} />
            ) : null}
          </div>
        </section>
      </div>
    </Surface>
  );
}

function MachineContext({
  machine,
  onFocus,
  onOpenTask,
  projectFocused
}: {
  machine: TopologyMachine;
  onFocus(): void;
  onOpenTask(taskId: string): void;
  projectFocused: boolean;
}) {
  const taskArea = topologyMachineTaskArea(machine);
  return (
    <div className="border-l border-neutral-800 pl-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <Button
          className="h-auto min-h-7 min-w-0 justify-start px-1.5 text-xs font-semibold"
          onPress={onFocus}
          size="sm"
          variant="ghost"
        >
          <span className="truncate">{machine.name}</span>
        </Button>
        <Chip className="ml-auto shrink-0 capitalize" size="sm">{machine.occupancy}</Chip>
      </div>

      <div className="mt-1.5 flex flex-wrap gap-1.5" aria-label={`${machine.name} worktrees`}>
        {machine.worktrees.map((worktree) => (
          <Chip className="max-w-full" key={worktree.id} size="sm">
            <GitBranch aria-hidden="true" className="size-3 shrink-0" />
            <span className="truncate">
              {worktree.branchName ?? (worktree.detached ? 'Detached checkout' : worktree.name)}
            </span>
          </Chip>
        ))}
        {machine.worktrees.length === 0 ? (
          <Text className="text-[11px] text-neutral-400">
            {worktreeInventoryLabel(machine)}
          </Text>
        ) : null}
      </div>

      <div className="mt-1.5 space-y-1" aria-label={`${machine.name} task ownership`}>
        {machine.tasks.map((task) => {
          const status = topologyTaskStatuses(task);
          return (
            <Button
              className="h-auto min-h-8 w-full justify-start gap-2 px-1.5 py-1 text-left"
              key={task.id}
              onPress={() => onOpenTask(task.id)}
              size="sm"
              variant="ghost"
            >
              <Bot aria-hidden="true" className="size-3 shrink-0 text-neutral-400" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[11px] text-neutral-300">
                  {task.issue ? `#${task.issue.number} · ` : ''}{task.title}
                </span>
                <span className="block truncate text-[10px] text-neutral-400">
                  {task.agentLabel} · {status.activity.label}
                  {status.delivery ? ` · ${status.delivery.label}` : ''}
                </span>
              </span>
            </Button>
          );
        })}
        {taskArea.kind !== 'tasks' ? (
          <Text className="block px-1.5 text-[11px] text-neutral-400">
            {taskArea.kind === 'proven-empty' ? taskArea.message : taskArea.label}
          </Text>
        ) : null}
      </div>
      {projectFocused ? null : (
        <EvidenceText truth={machine.inventory} />
      )}
    </div>
  );
}

function InventorySection<T>({
  icon,
  label,
  render,
  result
}: {
  icon: typeof CircleDot;
  label: string;
  render(data: T): ReactNode;
  result: TopologyInventoryResult<T>;
}) {
  return (
    <section className="mt-4 first:mt-0" aria-label={label}>
      <SectionHeading icon={icon} label={label} />
      <div className="mt-2">
        {result.state === 'ready' || result.state === 'stale' ? (
          result.data instanceof Array && result.data.length === 0 ? (
            <Text className="text-[11px] text-neutral-400">
              {result.state === 'stale'
                ? `No ${label.toLowerCase()} in the last safe snapshot`
                : `No ${label.toLowerCase()}`}
            </Text>
          ) : render(result.data)
        ) : (
          <Text className="text-[11px] text-neutral-400">
            {result.state === 'checking' ? 'Checking' : `Blocked · ${result.reason}`}
          </Text>
        )}
        {result.state === 'stale' ? (
          <Text className="mt-1 block text-[10px] text-amber-300">
            Stale snapshot · {result.reason}
          </Text>
        ) : null}
      </div>
    </section>
  );
}

function SectionHeading({ icon: Icon, label }: { icon: typeof Workflow; label: string }) {
  return (
    <div className="flex items-center gap-2 text-neutral-400">
      <Icon aria-hidden="true" className="size-3.5" />
      <Text className="text-[10px] font-semibold uppercase tracking-[0.12em]">{label}</Text>
    </div>
  );
}

function EvidenceText({ truth }: { truth: TopologyProject['inventory'] }) {
  const status = topologyTruthStatus(truth);
  return (
    <Text className="mt-1 block text-[11px] text-neutral-400">
      {status.label}{status.detail ? ` · ${status.detail}` : ''}
    </Text>
  );
}

function worktreeInventoryLabel(machine: TopologyMachine) {
  const inventory = machine.worktreeInventory;
  if (inventory.state === 'proven-empty') return 'No worktrees';
  if (inventory.state === 'ready') return 'Worktree inventory ready';
  if (inventory.state === 'checking') return 'Checking worktrees';
  if (inventory.state === 'stale') return `Stale worktrees · ${inventory.reason}`;
  return `Blocked worktrees · ${inventory.message}`;
}
