import { useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  GitBranch,
  Radio,
  Server,
  WifiOff
} from 'lucide-react';
import { Chip, Text } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import type { CodexMachine, CodexSession, ProjectCodexTaskStatus } from './codex-sessions-types';

const silenceThresholdMs = 45_000;

function useActivityClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const interval = window.setInterval(() => setNow(new Date()), 1_000);
    return () => window.clearInterval(interval);
  }, []);
  return now;
}

function age(value: string | undefined, now: Date) {
  if (!value) return 'unknown';
  const elapsed = Math.max(0, now.getTime() - Date.parse(value));
  if (!Number.isFinite(elapsed)) return 'unknown';
  if (elapsed < 5_000) return 'now';
  if (elapsed < 60_000) return `${Math.floor(elapsed / 1_000)}s ago`;
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  return `${Math.floor(elapsed / 3_600_000)}h ago`;
}

function elapsed(value: string | undefined, now: Date) {
  if (!value) return 'Starting';
  const duration = Math.max(0, now.getTime() - Date.parse(value));
  if (!Number.isFinite(duration)) return 'Starting';
  const seconds = Math.floor(duration / 1_000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return hours > 0
    ? `${hours}h ${minutes % 60}m`
    : minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function effectiveStatus(session: CodexSession): ProjectCodexTaskStatus {
  if (['archived', 'missing', 'offline', 'unavailable'].includes(session.status)) {
    return session.status;
  }
  const activity = session.activity;
  if (activity?.currentTurnState === 'waiting-for-approval') return 'waiting-approval';
  if (activity?.currentTurnState === 'waiting-for-user') return 'waiting-input';
  if (activity?.conversationState === 'running') return 'active';
  if (activity?.machineState === 'offline') return 'offline';
  if (activity?.processState === 'failed') return 'unavailable';
  return session.status;
}

function statusLabel(session: CodexSession) {
  if (session.status === 'archived') return 'Archived';
  if (session.status === 'missing') return 'No longer available';
  if (session.status === 'offline') return 'Connector offline';
  if (session.status === 'unavailable') return 'Unavailable';
  const activity = session.activity;
  if (activity?.freshness === 'stale') {
    return `Last known ${activity.conversationState === 'running' ? 'running' : activity.conversationState}`;
  }
  if (activity?.currentTurnState === 'waiting-for-approval' || activity?.currentTurnState === 'waiting-for-user') return 'Needs attention';
  if (activity?.currentTurnState === 'completed') return 'Completed';
  if (activity?.currentTurnState === 'failed') return 'Failed';
  if (activity?.currentTurnState === 'cancelled') return 'Stopped';
  if (activity?.conversationState === 'running') return 'Running';
  if (activity?.conversationState === 'failed') return 'Failed';
  return 'Idle';
}

function tone(status: ProjectCodexTaskStatus) {
  if (status === 'active') return 'text-emerald-300';
  if (status === 'waiting-approval' || status === 'waiting-input') return 'text-amber-300';
  if (status === 'offline' || status === 'unavailable' || status === 'missing') return 'text-red-300';
  return 'text-neutral-400';
}

export function CodexTaskStatusBar({ machine, session }: { machine?: CodexMachine; session: CodexSession }) {
  const now = useActivityClock();
  const activity = session.activity;
  const status = effectiveStatus(session);
  const branch = session.taskIdentity?.branch ?? session.cwd?.split(/[\\/]/).filter(Boolean).at(-1);
  const machineName = session.taskIdentity?.codespaceName ?? machine?.name ?? session.machineId;
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-neutral-900 px-3 py-2 text-[10px] text-neutral-500 md:px-4"
      data-codex-task-status={statusLabel(session).toLocaleLowerCase().replaceAll(' ', '-')}
    >
      <span className={cn('inline-flex items-center gap-1.5 font-semibold', tone(status))}>
        {status === 'active' ? <Activity className="size-3 animate-pulse" />
          : status === 'waiting-approval' || status === 'waiting-input' ? <AlertTriangle className="size-3" />
            : status === 'offline' ? <WifiOff className="size-3" /> : <CheckCircle2 className="size-3" />}
        {statusLabel(session)}
      </span>
      <span className="min-w-0 truncate text-neutral-300">{activity?.currentPhase ?? 'Task state unavailable'}</span>
      {activity?.currentTurnState === 'running' ? (
        <span className="inline-flex items-center gap-1"><Clock3 className="size-3" />{elapsed(activity.currentTurnStartedAt, now)}</span>
      ) : null}
      {session.taskIdentity?.issueNumber ? <Chip size="sm">#{session.taskIdentity.issueNumber}</Chip> : null}
      {branch ? (
        <span className="inline-flex min-w-0 items-center gap-1" title={session.taskIdentity?.worktree ?? session.cwd}>
          <GitBranch className="size-3 shrink-0" /><span className="max-w-56 truncate">{branch}</span>
        </span>
      ) : null}
      <span className="inline-flex min-w-0 items-center gap-1"><Server className="size-3 shrink-0" /><span className="max-w-44 truncate">{machineName}</span></span>
      <span className={cn('ml-auto inline-flex items-center gap-1', activity?.freshness === 'stale' ? 'text-amber-300' : 'text-emerald-400/80')}>
        <Radio className="size-3" />
        {activity?.freshness === 'stale' ? 'Stale' : 'Live'} · event {age(activity?.lastEventAt ?? session.lastActivityAt, now)}
      </span>
    </div>
  );
}

export function CodexLiveActivitySummary({ machine, session }: { machine?: CodexMachine; session: CodexSession }) {
  const now = useActivityClock();
  const activity = session.activity;
  const lastEventAt = activity?.lastEventAt ?? session.lastActivityAt;
  const silentFor = now.getTime() - Date.parse(lastEventAt);
  const running = activity?.conversationState === 'running'
    && !['archived', 'missing', 'offline', 'unavailable'].includes(session.status);
  const stalled = running && Number.isFinite(silentFor) && silentFor >= silenceThresholdMs;
  return (
    <section
      aria-label="Live Codex activity summary"
      className={cn(
        'shrink-0 border-b border-neutral-800/80 bg-app-panel px-4 py-3 sm:px-6',
        stalled && 'bg-amber-500/[0.035]'
      )}
      data-codex-live-summary={stalled ? 'stalled' : running ? 'running' : 'idle'}
    >
      <div className="mx-auto grid w-full max-w-[84ch] gap-2 sm:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_auto] sm:items-center">
        <div className="min-w-0">
          <Text className={cn('block text-xs font-semibold text-neutral-200', stalled && 'text-amber-200')}>
            {stalled ? 'No new activity — reconnecting' : activity?.currentPhase ?? 'Task activity is unavailable'}
          </Text>
          <Text className="mt-1 block truncate text-[10px] text-neutral-500">
            {stalled
              ? `The last event arrived ${age(lastEventAt, now)}. The task is preserved while ${machine?.name ?? 'the connector'} is checked.`
              : activity?.latestActivity ?? 'Waiting for the next meaningful event.'}
          </Text>
        </div>
        <div className="min-w-0 border-neutral-800 sm:border-l sm:pl-4">
          <Text className="block text-[9px] font-semibold uppercase tracking-[0.12em] text-neutral-600">Latest milestone</Text>
          <Text className="mt-1 block truncate text-[10px] text-neutral-400">{activity?.latestMilestone ?? 'No completed milestone reported yet'}</Text>
        </div>
        <span className={cn('inline-flex items-center gap-1.5 text-[10px]', stalled ? 'text-amber-300' : running ? 'text-emerald-300' : 'text-neutral-500')}>
          {stalled ? <AlertTriangle className="size-3" /> : running ? <Activity className="size-3 animate-pulse" /> : <CheckCircle2 className="size-3" />}
          {stalled ? 'Diagnostics active' : running ? `Active ${age(lastEventAt, now)}` : statusLabel(session)}
        </span>
      </div>
    </section>
  );
}
