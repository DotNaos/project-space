import {
  Bot,
  ExternalLink,
  FolderKanban,
  MessageSquareText,
  Monitor,
  Server
} from 'lucide-react';
import { Button, Chip, Surface, Text } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import {
  TopologyBrowserCapabilityNote,
  TopologyReadOnlyBrowserFrame
} from './project-topology-browser';
import {
  topologyBoundBrowserCapability,
  topologyTaskHeader
} from './project-topology-presentation';
import { TopologyTranscriptPreview } from './project-topology-transcript';
import type {
  ProjectTopologySnapshot,
  TopologyMachine,
  TopologyProject,
  TopologyTask
} from './project-topology-types';
import {
  topologyMachineTaskArea,
  topologyTaskStatuses,
  topologyTruthStatus,
  type TopologyStatusView
} from './project-topology-view-model';

const toneClasses: Record<TopologyStatusView['tone'], string> = {
  danger: 'text-red-300',
  neutral: 'text-neutral-400',
  success: 'text-emerald-400',
  warning: 'text-amber-300'
};

function StatusText({ status }: { status: TopologyStatusView }) {
  return (
    <span
      className={cn('inline-flex min-w-0 items-center gap-1.5', toneClasses[status.tone])}
      title={status.detail}
    >
      <span className="size-1.5 shrink-0 rounded-full bg-current" />
      <span className="truncate">{status.label}</span>
    </span>
  );
}

export function TopologyLeadNodeBody({
  lead,
  onOpenConversation,
  summary
}: {
  lead: ProjectTopologySnapshot['lead'];
  onOpenConversation?(): void;
  summary?: ProjectTopologySnapshot['summary'];
}) {
  return (
    <Surface
      aria-label="Portfolio Lead"
      className="flex size-full min-w-0 items-center gap-3 rounded-xl border-neutral-700 bg-neutral-950/95 px-3 shadow-xl shadow-black/25"
      data-topology-node-body="lead"
      role="group"
      variant="primary"
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-neutral-800 bg-neutral-900">
        <Bot aria-hidden="true" className="size-4 text-neutral-300" />
      </span>
      <span className="min-w-0">
        <Text as="h2" className="block truncate text-sm font-semibold text-neutral-100">
          {lead.label}
        </Text>
        <Text className="block truncate text-[10px] text-neutral-400">
          {summary
            ? `${summary.projectCount} projects · ${summary.machineCount} observed machines · ${summary.tasks.observedCount} observed tasks`
            : 'Cross-project coordination'}
        </Text>
      </span>
      {onOpenConversation ? (
        <Button
          aria-label="Chat with Lead"
          className="nodrag nopan ml-auto size-8 min-h-0"
          isIconOnly
          onClick={(event) => event.stopPropagation()}
          onPress={onOpenConversation}
          size="sm"
          variant="ghost"
        >
          <MessageSquareText aria-hidden="true" className="size-3.5" />
        </Button>
      ) : null}
    </Surface>
  );
}

export function TopologyProjectNodeBody({
  focused = false,
  onOpenConversation,
  project
}: {
  focused?: boolean;
  onOpenConversation?(): void;
  project: TopologyProject;
}) {
  const status = topologyTruthStatus(project.inventory);
  return (
    <Surface
      className={cn(
        'size-full overflow-hidden rounded-xl bg-neutral-900/75 transition-[border-color,box-shadow] duration-300',
        focused && 'border-neutral-500 shadow-[0_0_0_1px_rgba(255,255,255,0.08)]'
      )}
      data-focused={focused || undefined}
      data-topology-node-body="project"
      aria-label={`${project.name} project`}
      role="group"
      variant="primary"
    >
      <header className="flex h-14 min-w-0 items-center gap-3 border-b border-neutral-800 bg-neutral-950/85 px-3">
        <FolderKanban aria-hidden="true" className="size-3.5 shrink-0 text-neutral-400" />
        <span className="min-w-0">
          <Text as="h2" className="block truncate text-xs font-semibold text-neutral-100">
            {project.name}
          </Text>
          <Text className="mt-0.5 block truncate text-[10px] text-neutral-400">
            {project.repositoryFullName ?? project.repositoryUrl ?? 'Repository not reported'}
          </Text>
        </span>
        <span className="ml-auto hidden shrink-0 items-center gap-2 text-[9px] text-neutral-400 min-[360px]:flex">
          {project.machines.length > 0 ? (
            <span>{project.machines.length} machine{project.machines.length === 1 ? '' : 's'}</span>
          ) : null}
          <StatusText status={status} />
        </span>
        {onOpenConversation ? (
          <Button
            aria-label={`Chat with ${project.name} Project Lead`}
            className="nodrag nopan size-8 min-h-0"
            isIconOnly
            onClick={(event) => event.stopPropagation()}
            onPress={onOpenConversation}
            size="sm"
            variant="ghost"
          >
            <MessageSquareText aria-hidden="true" className="size-3.5" />
          </Button>
        ) : null}
      </header>
    </Surface>
  );
}

function MachineTaskState({ machine }: { machine: TopologyMachine }) {
  const area = topologyMachineTaskArea(machine);
  if (area.kind === 'tasks') return null;
  return (
    <div className="flex h-8 items-center gap-2 px-3 text-[10px] text-neutral-400">
      <span className="size-1.5 rounded-full bg-current" />
      <Text className="truncate">
        {area.kind === 'proven-empty' ? area.message : area.label}
      </Text>
      {area.kind === 'unavailable' && area.detail ? (
        <Text className="ml-auto max-w-[55%] truncate text-neutral-500">{area.detail}</Text>
      ) : null}
    </div>
  );
}

export function TopologyMachineNodeBody({
  focused = false,
  machine
}: {
  focused?: boolean;
  machine: TopologyMachine;
}) {
  const status = topologyTruthStatus(machine.inventory);
  return (
    <Surface
      className={cn(
        'size-full overflow-hidden rounded-lg bg-neutral-900/85 transition-[border-color,box-shadow] duration-300',
        focused && 'border-neutral-500 shadow-[0_0_0_1px_rgba(255,255,255,0.07)]'
      )}
      data-focused={focused || undefined}
      data-topology-node-body="machine"
      aria-label={`${machine.name} machine`}
      role="group"
      variant="primary"
    >
      <header className="flex h-12 min-w-0 items-center gap-2 border-b border-neutral-800/80 bg-neutral-950/35 px-3">
        <Monitor aria-hidden="true" className="size-3.5 shrink-0 text-neutral-400" />
        <Text as="h3" className="truncate text-[11px] font-semibold text-neutral-200">
          {machine.name}
        </Text>
        <Chip className="shrink-0 capitalize" size="sm">{machine.occupancy}</Chip>
        <span className="ml-auto hidden shrink-0 text-[9px] min-[330px]:inline-flex">
          <StatusText status={status} />
        </span>
        {machine.tasks.length > 0 ? (
          <span className="shrink-0 text-[9px] uppercase tracking-[0.12em] text-neutral-500">
            {machine.tasks.length} task{machine.tasks.length === 1 ? '' : 's'}
          </span>
        ) : null}
      </header>
      <MachineTaskState machine={machine} />
    </Surface>
  );
}

export function TopologyTaskNodeBody({
  focused = false,
  onOpen,
  task
}: {
  focused?: boolean;
  onOpen?(): void;
  task: TopologyTask;
}) {
  const header = topologyTaskHeader(task);
  const statuses = topologyTaskStatuses(task);
  const browserCapability = topologyBoundBrowserCapability(task);
  const browser = browserCapability.state === 'ready' ? browserCapability : undefined;
  return (
    <Surface
      className={cn(
        'flex size-full flex-col overflow-hidden rounded-lg bg-neutral-950 transition-[border-color,box-shadow] duration-300',
        focused && 'border-neutral-400 shadow-[0_0_0_1px_rgba(255,255,255,0.1)]'
      )}
      data-focused={focused || undefined}
      data-topology-node-body="task"
      aria-label={`${header.issueLabel ?? 'Task'} ${header.title}`}
      role="article"
      variant="primary"
    >
      <header className="flex h-11 min-w-0 items-center gap-2 border-b border-neutral-800/80 px-2.5">
        {header.issueLabel ? (
          <Text className="shrink-0 text-[10px] font-semibold text-neutral-100">
            {header.issueLabel}
          </Text>
        ) : (
          <Server aria-hidden="true" className="size-3 shrink-0 text-neutral-500" />
        )}
        <Text as="h3" className="truncate text-[10px] font-semibold text-neutral-200">
          {header.title}
        </Text>
        {header.branchName ? (
          <Chip className="max-w-[36%] shrink truncate" size="sm">
            {header.branchName}
          </Chip>
        ) : null}
        <span className="ml-auto hidden shrink-0 text-[9px] min-[350px]:inline-flex">
          <StatusText status={statuses.activity} />
        </span>
        {onOpen ? (
          <Button
            aria-label={`Open ${header.issueLabel ?? header.title} command center`}
            className="nodrag nopan size-7 min-h-0"
            isIconOnly
            onClick={(event) => event.stopPropagation()}
            onPress={onOpen}
            size="sm"
            variant="ghost"
          >
            <ExternalLink aria-hidden="true" className="size-3" />
          </Button>
        ) : null}
      </header>
      <div className={cn(
        'relative min-h-0 flex-1',
        !browser && 'flex flex-col',
        browser && 'grid grid-cols-[minmax(0,0.42fr)_minmax(0,0.58fr)]'
      )}>
        <TopologyTranscriptPreview agentLabel={header.agentLabel} transcript={task.transcript} />
        {browser ? (
          <TopologyReadOnlyBrowserFrame compact frameUrl={browser.frameUrl} title={task.title} />
        ) : (
          <span className="pointer-events-none flex h-5 shrink-0 items-center justify-end border-t border-neutral-800/60 px-2">
            <TopologyBrowserCapabilityNote browser={browserCapability} compact />
          </span>
        )}
      </div>
    </Surface>
  );
}
