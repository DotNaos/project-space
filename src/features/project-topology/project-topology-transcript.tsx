import type { ComponentType } from 'react';
import {
  Bot,
  BrainCircuit,
  CheckCircle2,
  CircleDotDashed,
  FilePenLine,
  ListChecks,
  LoaderCircle,
  MessageSquareText,
  TerminalSquare,
  Wrench,
  XCircle
} from 'lucide-react';
import { ScrollShadow, Surface, Text } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import {
  topologyTranscriptItemText,
  topologyTranscriptPresentation,
  topologyTranscriptPreviewItems
} from './project-topology-presentation';
import type {
  TopologyInventoryResult,
  TopologyTranscriptItem
} from './project-topology-types';

const itemIcons: Record<
  Exclude<TopologyTranscriptItem['kind'], 'agent-message' | 'user-message'>,
  ComponentType<{ className?: string }>
> = {
  command: TerminalSquare,
  'file-change': FilePenLine,
  'mcp-tool': Wrench,
  plan: ListChecks,
  reasoning: BrainCircuit,
  status: CircleDotDashed
};

const statusIcons = {
  completed: CheckCircle2,
  failed: XCircle,
  'in-progress': LoaderCircle,
  pending: CircleDotDashed
} as const;

function TranscriptState({
  compact = false,
  transcript
}: {
  compact?: boolean;
  transcript: TopologyInventoryResult<TopologyTranscriptItem[]>;
}) {
  const presentation = topologyTranscriptPresentation(transcript);
  if (presentation.state === 'ready' && presentation.items.length > 0) return null;

  return (
    <div
      className={cn(
        'flex min-w-0 items-start gap-2 text-neutral-500',
        compact ? 'px-2.5 py-2 text-[8px]' : 'border-b border-neutral-800/70 px-4 py-2.5 text-[10px]',
        presentation.state === 'blocked' && 'text-red-300/75',
        presentation.state === 'stale' && 'text-amber-300/75'
      )}
      data-transcript-state={presentation.state}
      role={presentation.state === 'blocked' ? 'alert' : 'status'}
    >
      {presentation.state === 'checking' ? (
        <LoaderCircle className="mt-0.5 size-3 shrink-0 animate-spin" />
      ) : (
        <CircleDotDashed className="mt-0.5 size-3 shrink-0" />
      )}
      <span className="min-w-0">
        <Text className="block font-medium">{presentation.label}</Text>
        {presentation.detail && !compact ? (
          <Text className="mt-0.5 block leading-4 text-neutral-600">
            {presentation.detail}
          </Text>
        ) : null}
      </span>
    </div>
  );
}

function PreviewItem({ item }: { item: TopologyTranscriptItem }) {
  if (item.kind === 'agent-message' || item.kind === 'user-message') {
    const Icon = item.kind === 'agent-message' ? Bot : MessageSquareText;
    return (
      <div className="flex min-w-0 items-start gap-1.5 text-[8px] leading-3 text-neutral-400">
        <Icon className="mt-px size-2.5 shrink-0 text-neutral-600" />
        <Text className="line-clamp-2">{topologyTranscriptItemText(item)}</Text>
      </div>
    );
  }
  const Icon = itemIcons[item.kind];
  const StatusIcon = item.status ? statusIcons[item.status] : undefined;
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-[8px] text-neutral-500">
      <Icon className="size-2.5 shrink-0" />
      <Text className="truncate">{topologyTranscriptItemText(item)}</Text>
      {StatusIcon ? (
        <StatusIcon className={cn(
          'ml-auto size-2.5 shrink-0',
          item.status === 'in-progress' && 'animate-spin text-neutral-300',
          item.status === 'failed' && 'text-red-400'
        )} />
      ) : null}
    </div>
  );
}

export function TopologyTranscriptPreview({
  agentLabel,
  transcript
}: {
  agentLabel: string;
  transcript: TopologyInventoryResult<TopologyTranscriptItem[]>;
}) {
  const presentation = topologyTranscriptPresentation(transcript);
  const items = topologyTranscriptPreviewItems(transcript);
  return (
    <section
      aria-label="Read-only Codex task transcript"
      className="flex size-full min-w-0 flex-col overflow-hidden bg-neutral-950/75"
      data-transcript-state={presentation.state}
    >
      <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-neutral-800/70 px-2.5 text-[8px] text-neutral-600">
        <span className={cn(
          'size-1.5 rounded-full',
          presentation.state === 'ready' ? 'bg-emerald-400' : 'bg-neutral-600'
        )} />
        <Text className="truncate font-medium text-neutral-400">{agentLabel}</Text>
        <Text className="shrink-0">read-only task</Text>
      </div>
      {items.length > 0 ? (
        <div className="grid min-h-0 flex-1 content-start gap-2 overflow-hidden p-2.5">
          {items.map((item) => <PreviewItem item={item} key={`${item.turnId}:${item.id}`} />)}
        </div>
      ) : (
        <TranscriptState compact transcript={transcript} />
      )}
      {presentation.state === 'stale' && items.length > 0 ? (
        <Text className="shrink-0 px-2.5 pb-1.5 text-[7px] text-amber-300/70">
          Stale snapshot
        </Text>
      ) : null}
    </section>
  );
}

function AgentMessage({ item }: { item: TopologyTranscriptItem }) {
  return (
    <article className="flex gap-3 py-3" data-transcript-kind={item.kind}>
      <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full border border-neutral-800 bg-neutral-900">
        <Bot className="size-3.5 text-neutral-400" />
      </span>
      <Text className="max-w-[80ch] whitespace-pre-wrap text-[13px] leading-6 text-neutral-200">
        {topologyTranscriptItemText(item)}
      </Text>
    </article>
  );
}

function UserMessage({ item }: { item: TopologyTranscriptItem }) {
  return (
    <article className="flex justify-end py-3" data-transcript-kind={item.kind}>
      <Surface className="max-w-[80ch] rounded-2xl rounded-br-sm px-3.5 py-2.5" variant="primary">
        <Text className="block text-[10px] font-medium text-neutral-500">You</Text>
        <Text className="mt-1 block whitespace-pre-wrap text-[13px] leading-5 text-neutral-100">
          {topologyTranscriptItemText(item)}
        </Text>
      </Surface>
    </article>
  );
}

function ActivityItem({ item }: { item: TopologyTranscriptItem }) {
  if (item.kind === 'agent-message' || item.kind === 'user-message') return null;
  const Icon = itemIcons[item.kind];
  const StatusIcon = item.status ? statusIcons[item.status] : undefined;
  const text = topologyTranscriptItemText(item);
  const detail = item.detail?.trim();
  return (
    <div
      className="ml-3 flex min-w-0 items-start gap-2 border-l border-neutral-800 py-2 pl-3 text-[11px] text-neutral-500"
      data-transcript-kind={item.kind}
    >
      <Icon className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0">
        <Text className="block text-neutral-300">{text}</Text>
        {detail && detail !== text ? (
          <Text className="mt-0.5 block whitespace-pre-wrap text-[10px] leading-4 text-neutral-600">
            {detail}
          </Text>
        ) : null}
      </span>
      {StatusIcon ? (
        <StatusIcon className={cn(
          'ml-auto mt-0.5 size-3 shrink-0',
          item.status === 'in-progress' && 'animate-spin text-neutral-300',
          item.status === 'failed' && 'text-red-400',
          item.status === 'completed' && 'text-emerald-400/75'
        )} />
      ) : null}
    </div>
  );
}

export function TopologyTranscript({
  transcript
}: {
  transcript: TopologyInventoryResult<TopologyTranscriptItem[]>;
}) {
  const presentation = topologyTranscriptPresentation(transcript);
  return (
    <section
      aria-label="Ordered Codex task transcript"
      className="flex min-h-0 flex-1 flex-col bg-neutral-950"
      data-transcript-state={presentation.state}
    >
      <TranscriptState transcript={transcript} />
      {presentation.items.length > 0 ? (
        <ScrollShadow
          aria-live="polite"
          className="min-h-0 flex-1 px-4 py-3 sm:px-5"
          role="log"
        >
          {presentation.items.map((item) => (
            item.kind === 'agent-message' ? (
              <AgentMessage item={item} key={`${item.turnId}:${item.id}`} />
            ) : item.kind === 'user-message' ? (
              <UserMessage item={item} key={`${item.turnId}:${item.id}`} />
            ) : (
              <ActivityItem item={item} key={`${item.turnId}:${item.id}`} />
            )
          ))}
        </ScrollShadow>
      ) : (
        <div className="min-h-0 flex-1" />
      )}
    </section>
  );
}
