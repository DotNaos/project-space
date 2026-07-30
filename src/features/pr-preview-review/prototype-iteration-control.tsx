import { useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import {
  CircleAlert,
  ExternalLink,
  Laptop,
  Play,
  Server,
  ShieldCheck
} from 'lucide-react';

import type { PullRequestPrototypeIterationResult } from '@/shared/pr-prototype-iteration-api';
import { codexSessionRoute } from '@/features/codex-sessions/codex-session-route';

const stateLabels = {
  mismatched: 'Identity mismatch',
  offline: 'Machine offline',
  stale: 'Evidence stale',
  unauthorized: 'Not authorized',
  unavailable: 'Live context unavailable'
} as const;

export function PrototypeIterationControl({
  error,
  result,
  liveOpened,
  starting,
  onOpen,
  onReturnToDeployed,
  onStart
}: {
  error?: string;
  result?: PullRequestPrototypeIterationResult;
  liveOpened: boolean;
  starting: boolean;
  onOpen(url: string): void;
  onReturnToDeployed(): void;
  onStart(): void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const currentTime = Math.max(now, Date.now());
  const leaseFresh = result?.state === 'available' &&
    Number.isFinite(Date.parse(result.leaseExpiresAt)) &&
    Date.parse(result.leaseExpiresAt) > currentTime;

  useEffect(() => {
    if (result?.state !== 'available') return;
    const remaining = Math.max(0, Date.parse(result.leaseExpiresAt) - Date.now());
    const timer = window.setTimeout(() => setNow(Date.now()), remaining + 1);
    return () => window.clearTimeout(timer);
  }, [result]);

  const label = result
    ? result.state === 'available'
      ? leaseFresh
        ? 'Live server verified'
        : 'Evidence stale'
      : result.state === 'startable'
        ? starting
          ? 'Server starting'
          : result.serverState === 'stopped'
            ? result.serverStartedAt ? 'Server stopped' : 'Not started'
            : result.serverState === 'running'
              ? 'Server ready to reuse'
              : result.serverState === 'error'
                ? 'Server needs restart'
                : `Server ${result.serverState}`
        : stateLabels[result.state]
    : error ?? 'Checking live context…';
  const Icon = result?.state === 'available' && leaseFresh
    ? ShieldCheck
    : result?.state === 'startable'
      ? Server
      : CircleAlert;

  return (
    <details className="group relative">
      <summary className="flex h-12 cursor-pointer list-none items-center gap-2 rounded-full bg-neutral-900/95 px-4 text-sm text-neutral-200 shadow-[0_14px_42px_rgba(0,0,0,0.32)] backdrop-blur-xl marker:hidden">
        <Icon className="size-4 shrink-0" />
        <span className="max-w-44 truncate">{label}</span>
      </summary>
      <section className="absolute bottom-14 left-0 z-[70] w-[min(28rem,calc(100vw-1rem))] border border-neutral-800 bg-neutral-950/95 p-4 text-neutral-100 shadow-2xl backdrop-blur-xl max-[640px]:fixed max-[640px]:inset-x-2 max-[640px]:bottom-16 max-[640px]:w-auto">
        <div className="flex items-center gap-2">
          <Laptop className="size-4 text-neutral-400" />
          <h2 className="text-sm font-semibold">Trusted live-development context</h2>
        </div>
        {result && 'identity' in result ? (
          <dl className="mt-3 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
            <dt className="text-neutral-500">Repository</dt>
            <dd className="truncate">{result.identity.repositoryFullName}</dd>
            <dt className="text-neutral-500">Pull request</dt>
            <dd>#{result.identity.pullRequestNumber}</dd>
            <dt className="text-neutral-500">Machine</dt>
            <dd className="truncate">{result.identity.machineName} · {result.identity.machineId}</dd>
            <dt className="text-neutral-500">Worktree</dt>
            <dd className="truncate" title={result.identity.worktreePath}>
              {result.identity.worktreePath}
            </dd>
            <dt className="text-neutral-500">Branch</dt>
            <dd className="truncate">{result.identity.branchName}</dd>
            <dt className="text-neutral-500">Commit</dt>
            <dd className="font-mono">{result.identity.headSha.slice(0, 12)}</dd>
            <dt className="text-neutral-500">Codex task</dt>
            <dd className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate">{result.identity.codexTask.title}</span>
              <Button
                aria-label="Open verified Codex task"
                size="sm"
                variant="ghost"
                onPress={() => {
                  window.open(codexSessionRoute({
                    machineId: result.identity.connectorId,
                    threadId: result.identity.codexTask.threadId
                  }), '_blank', 'noopener,noreferrer');
                }}
              >
                Open task
              </Button>
            </dd>
            <dt className="text-neutral-500">Server</dt>
            <dd>{result.identity.serverId}</dd>
          </dl>
        ) : (
          <>
            {result && 'evidence' in result ? (
              <dl className="mt-3 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                <dt className="text-neutral-500">Repository</dt>
                <dd className="truncate">{result.evidence.repositoryFullName}</dd>
                <dt className="text-neutral-500">Pull request</dt>
                <dd>#{result.evidence.pullRequestNumber}</dd>
                {result.evidence.machineName ? (
                  <>
                    <dt className="text-neutral-500">Machine</dt>
                    <dd className="truncate">
                      {result.evidence.machineName} · {result.evidence.machineId}
                    </dd>
                  </>
                ) : null}
              </dl>
            ) : null}
            <p className="mt-3 text-xs leading-5 text-neutral-400">
              {error ?? (result && 'reasonCode' in result
                ? result.reasonCode.replaceAll('-', ' ')
                : 'Project Space is checking current evidence.')}
            </p>
          </>
        )}
        <div className="mt-4 flex justify-end">
          {result?.state === 'available' && leaseFresh ? (
            <Button
              size="sm"
              variant="primary"
              onPress={() => liveOpened ? onReturnToDeployed() : onOpen(result.url)}
            >
              <ExternalLink className="size-4" />
              {liveOpened ? 'View deployed prototype' : 'Open dev server'}
            </Button>
          ) : result?.state === 'startable' ? (
            <Button
              isDisabled={starting}
              size="sm"
              variant="primary"
              onPress={onStart}
            >
              <Play className="size-4" />
              {starting ? 'Starting…' : 'Start dev server'}
            </Button>
          ) : null}
        </div>
      </section>
    </details>
  );
}
