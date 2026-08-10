import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  Clock3,
  Monitor,
  WifiOff
} from 'lucide-react';
import { Button } from '@/app/dotnaos-ui';
import type { CodexMachineTaskExistingResult } from '@/shared/codex-machine-tasks-api';
import type { CodexSession } from '../../codex-sessions/codex-sessions-types';
import { codexSessionRoute } from '../../codex-sessions/codex-session-route';
import { preferCodexTaskActivity } from '../../../shared/codex-task-activity';
import {
  formatIssueCodexActivity,
  presentIssueCodexInventoryThread,
  presentIssueCodexThread,
  type IssueCodexThreadPresentation
} from './issue-codex-work-list-model';

interface IssueCodexThreadLocation {
  environmentLabel: string;
  isOnline?: boolean;
  key: string;
  physicalMachineName: string;
}

export type IssueCodexThreadEntry = IssueCodexThreadLocation & (
  | {
      kind: 'associated';
      result: Exclude<CodexMachineTaskExistingResult, { state: 'missing' }>;
    }
  | {
      kind: 'inventory';
      session: CodexSession;
    }
);

export function issueCodexThreadIdentity(entry: IssueCodexThreadEntry) {
  if (entry.kind === 'inventory') {
    return `${entry.session.machineId}:${entry.session.threadId}`;
  }
  return entry.result.state === 'confirmed'
    ? `${entry.result.task.connector.id}:${entry.result.task.threadId}`
    : `attention:${entry.key}`;
}

function incomingSessionIsPreferred(
  current: { activity?: CodexSession['activity']; lastActivityAt: string },
  incoming: { activity?: CodexSession['activity']; lastActivityAt: string }
) {
  if (current.activity?.freshness === 'live' && incoming.activity?.freshness === 'stale') {
    return false;
  }
  if (current.activity && incoming.activity) {
    return preferCodexTaskActivity(current.activity, incoming.activity) === incoming.activity;
  }
  if (current.activity && !incoming.activity) return false;
  if (!current.activity && incoming.activity) return true;
  return (Date.parse(incoming.lastActivityAt) || 0) >= (Date.parse(current.lastActivityAt) || 0);
}

function preferredAssociatedResult(
  current: Extract<IssueCodexThreadEntry, { kind: 'associated' }>['result'],
  incoming: Extract<IssueCodexThreadEntry, { kind: 'associated' }>['result']
) {
  if (current.state !== 'confirmed' || incoming.state !== 'confirmed') return current;
  if (!current.session && incoming.session) return incoming;
  if (
    current.session
    && incoming.session
    && incomingSessionIsPreferred(current.session, incoming.session)
  ) {
    return incoming;
  }
  return current;
}

export function mergeIssueCodexThreadEntries(
  associated: readonly IssueCodexThreadEntry[],
  inventory: readonly IssueCodexThreadEntry[]
) {
  const unique = new Map<string, IssueCodexThreadEntry>();
  for (const entry of associated) {
    const identity = issueCodexThreadIdentity(entry);
    const existing = unique.get(identity);
    if (!existing) {
      unique.set(identity, entry);
      continue;
    }
    if (existing.kind !== 'associated' || entry.kind !== 'associated') continue;
    const isOnline = existing.isOnline === false || entry.isOnline === false
      ? false
      : existing.isOnline ?? entry.isOnline;
    const result = preferredAssociatedResult(existing.result, entry.result);
    unique.set(identity, { ...existing, isOnline, result });
  }
  for (const entry of inventory) {
    const identity = issueCodexThreadIdentity(entry);
    const existing = unique.get(identity);
    const isOnline = existing?.isOnline === false
      || entry.isOnline === false
      || (entry.kind === 'inventory' && (
        entry.session.status === 'offline' || entry.session.activity?.machineState === 'offline'
      ))
      ? false
      : existing?.isOnline ?? entry.isOnline;
    if (
      existing?.kind === 'associated'
      && existing.result.state === 'confirmed'
      && existing.result.session
      && entry.kind === 'inventory'
    ) {
      if (!incomingSessionIsPreferred(existing.result.session, entry.session)) {
        if (isOnline === false) unique.set(identity, { ...existing, isOnline });
        continue;
      }
    }
    unique.set(identity, existing ? {
      ...entry,
      environmentLabel: existing.environmentLabel,
      isOnline,
      physicalMachineName: existing.physicalMachineName
    } : entry);
  }
  return [...unique.values()];
}

export function issueCodexThreadPresentation(
  entry: IssueCodexThreadEntry,
  issueNumber: number
) {
  const presentation = entry.kind === 'inventory'
    ? presentIssueCodexInventoryThread(entry.session, issueNumber)
    : presentIssueCodexThread(entry.result);
  if (
    entry.isOnline === false
  ) {
    return {
      ...presentation,
      actionLabel: 'Resolve' as const,
      running: false,
      state: 'offline' as const,
      stateLabel: 'Offline / last known'
    };
  }
  return presentation;
}

function stateTone(presentation: IssueCodexThreadPresentation) {
  if (presentation.state === 'running') return 'text-emerald-300';
  if (presentation.state === 'attention') return 'text-amber-300';
  if (presentation.state === 'offline') return 'text-red-300/80';
  return 'text-current/45';
}

function ThreadState({ presentation }: { presentation: IssueCodexThreadPresentation }) {
  const className = `inline-flex items-center gap-1.5 text-[10px] ${stateTone(presentation)}`;
  if (presentation.state === 'running') {
    return <span className={className}><Activity className="size-3 animate-pulse" />{presentation.stateLabel}</span>;
  }
  if (presentation.state === 'attention') {
    return <span className={className}><AlertTriangle className="size-3" />{presentation.stateLabel}</span>;
  }
  if (presentation.state === 'offline') {
    return <span className={className}><WifiOff className="size-3" />{presentation.stateLabel}</span>;
  }
  return <span className={className}><CheckCircle2 className="size-3" />{presentation.stateLabel}</span>;
}

export function IssueCodexThreadRow({
  entry,
  issueNumber,
  now,
  onError
}: {
  entry: IssueCodexThreadEntry;
  issueNumber: number;
  now: Date;
  onError(message: string): void;
}) {
  const presentation = issueCodexThreadPresentation(entry, issueNumber);
  const open = () => {
    if (entry.kind === 'associated' && entry.result.state === 'attention') {
      onError(entry.result.message);
      return;
    }
    const origin = entry.kind === 'inventory'
      ? { machineId: entry.session.machineId, threadId: entry.session.threadId }
      : entry.result.state === 'confirmed'
        ? {
            machineId: entry.result.task.connector.id,
            threadId: entry.result.task.threadId
          }
        : undefined;
    if (!origin) return;
    window.location.assign(codexSessionRoute(origin));
  };

  return (
    <div
      className="grid min-w-0 gap-2 border-t border-current/[.07] py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
      data-codex-thread-state={presentation.state}
    >
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {presentation.running
            ? <Activity className="size-3.5 shrink-0 animate-pulse text-emerald-300" />
            : <Bot className="size-3.5 shrink-0 text-current/35" />}
          <span className="min-w-0 truncate text-xs font-semibold text-current/75">
            {presentation.title}
          </span>
          <ThreadState presentation={presentation} />
        </div>
        <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 pl-5 text-[10px] text-current/40">
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <Monitor className="size-3 shrink-0" />
            <span className="truncate">{entry.physicalMachineName} · {entry.environmentLabel}</span>
          </span>
          <span className="inline-flex items-center gap-1.5" title={presentation.activityLabel}>
            <Clock3 className="size-3 shrink-0" />
            {formatIssueCodexActivity(presentation.activityAt, now)}
          </span>
        </div>
      </div>
      <Button
        className="justify-self-start sm:justify-self-end"
        onPress={open}
        size="sm"
        title={presentation.message}
        variant={presentation.state === 'attention' ? 'outline' : presentation.running ? 'primary' : 'ghost'}
      >
        {presentation.actionLabel ?? 'Resolve'}
      </Button>
    </div>
  );
}
