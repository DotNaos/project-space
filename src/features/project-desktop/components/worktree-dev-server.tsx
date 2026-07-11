import { useEffect, useState } from 'react';
import {
  Check,
  Copy,
  ExternalLink,
  LoaderCircle,
  Play,
  RotateCcw,
  Square
} from 'lucide-react';

import { Button, Text } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import type {
  MachineMembershipAccess,
  WorktreeDevServerRecord
} from '@/shared/project-space-api';

function visibleTailscaleUrl(server: WorktreeDevServerRecord | undefined) {
  if (
    server?.state !== 'running' ||
    !server.tailscaleUrl ||
    !server.tailscaleIPv4 ||
    !server.publicPort ||
    !server.verifiedAt
  ) {
    return undefined;
  }

  try {
    const url = new URL(server.tailscaleUrl);
    const verifiedAt = Date.parse(server.verifiedAt);
    const ageMs = Date.now() - verifiedAt;
    const octets = server.tailscaleIPv4.split('.').map(Number);
    const isTailscaleIPv4 =
      octets.length === 4 &&
      octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) &&
      octets[0] === 100 &&
      octets[1]! >= 64 &&
      octets[1]! <= 127;
    const matchesExposure =
      url.protocol === 'http:' &&
      url.hostname === server.tailscaleIPv4 &&
      Number(url.port) === server.publicPort &&
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === '';

    return isTailscaleIPv4 && matchesExposure && ageMs >= -5_000 && ageMs <= 30_000
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

export function DevServerAccessNotice({
  access,
  machineName
}: {
  access?: MachineMembershipAccess;
  machineName?: string;
}) {
  if (!access || access === 'owner' || access === 'member') {
    return null;
  }

  if (access === 'unclaimed') {
    return (
      <div className="mb-3 border-b border-neutral-800/80 px-1 pb-3">
        <div className="min-w-0">
          <Text className="block text-xs font-semibold text-neutral-200">
            Machine enrollment required
          </Text>
          <Text className="mt-0.5 block text-xs text-neutral-500">
            Reinstall the connector for {machineName || 'this machine'} from your account settings.
            The per-user installer securely assigns the machine to your account.
          </Text>
        </div>
      </div>
    );
  }

  const message =
    access === 'database-required'
      ? 'A database connection is required to keep machine access and run settings per user.'
      : 'This machine is assigned to another Project Space account.';

  return (
    <div className="mb-3 border-b border-neutral-800/80 px-1 pb-3">
      <Text className="block text-xs text-amber-200/90">{message}</Text>
    </div>
  );
}

export function WorktreeDevServerAction({
  access,
  isChecking,
  isPending,
  onStart,
  onStop,
  server
}: {
  access?: MachineMembershipAccess;
  isChecking: boolean;
  isPending: boolean;
  onStart(): void;
  onStop(): void;
  server?: WorktreeDevServerRecord;
}) {
  if (!access || access === 'unclaimed' || access === 'denied' || access === 'database-required') {
    return null;
  }

  if (!server && isChecking) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-neutral-500">
        <LoaderCircle className="size-3.5 animate-spin" />
        Checking
      </span>
    );
  }

  if (!server || server.capability === 'unavailable') {
    return <span className="text-xs text-neutral-600">No dev script</span>;
  }

  if (server.state === 'starting' || server.state === 'stopping' || isPending) {
    return (
      <Button size="sm" variant="ghost" isDisabled>
        <LoaderCircle className="size-3.5 animate-spin" />
        {server.state === 'stopping' ? 'Stopping' : 'Starting'}
      </Button>
    );
  }

  if (server.state === 'running') {
    return (
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-neutral-200">
          <span className="size-1.5 rounded-full bg-neutral-100 shadow-[0_0_0_3px_rgba(255,255,255,0.08)]" />
          Running
        </span>
        <Button size="sm" variant="ghost" onPress={onStop}>
          <Square className="size-3" />
          Stop
        </Button>
      </div>
    );
  }

  const retry = server.state === 'error';
  return (
    <Button size="sm" variant={retry ? 'secondary' : 'primary'} onPress={onStart}>
      {retry ? <RotateCcw className="size-3.5" /> : <Play className="size-3.5 fill-current" />}
      {retry ? 'Retry' : `Run ${server.runTarget}`}
    </Button>
  );
}

export function WorktreeDevServerDetails({
  machineName,
  server
}: {
  machineName?: string;
  server?: WorktreeDevServerRecord;
}) {
  const [copied, setCopied] = useState(false);
  const [, setFreshnessTick] = useState(0);
  const url = visibleTailscaleUrl(server);

  useEffect(() => {
    setCopied(false);
  }, [url]);

  useEffect(() => {
    if (!server?.verifiedAt) {
      return;
    }
    const expiresInMs = Math.max(0, Date.parse(server.verifiedAt) + 30_001 - Date.now());
    const timer = window.setTimeout(() => setFreshnessTick((value) => value + 1), expiresInMs);
    return () => window.clearTimeout(timer);
  }, [server?.verifiedAt]);

  if (
    !server ||
    server.capability === 'unavailable' ||
    (server.state === 'stopped' && !server.lastError)
  ) {
    return null;
  }

  async function copyUrl() {
    if (!url) {
      return;
    }

    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div
      aria-live="polite"
      className="ml-10 mr-3 border-l border-neutral-800 px-3 pb-3 pt-1 text-xs"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <span
          className={cn(
            'font-medium',
            server.state === 'error' ? 'text-red-300' : 'text-neutral-400'
          )}
        >
          {server.state === 'error'
            ? 'Could not start'
            : `${server.state[0]?.toUpperCase()}${server.state.slice(1)} on ${machineName || 'machine'}`}
        </span>

        {url ? (
          <>
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-w-0 items-center gap-1.5 font-mono text-neutral-100 underline decoration-neutral-700 underline-offset-4 transition hover:decoration-neutral-200"
            >
              <span className="max-w-[24rem] truncate">{url}</span>
              <ExternalLink className="size-3.5 shrink-0" />
            </a>
            <Button
              aria-label="Copy Tailscale URL"
              size="sm"
              variant="ghost"
              isIconOnly
              onPress={() => void copyUrl()}
              className="min-h-7"
            >
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            </Button>
          </>
        ) : null}
      </div>

      {server.lastError ? (
        <Text className="mt-1.5 block max-w-3xl text-red-300/80">{server.lastError}</Text>
      ) : null}
      {server.localUrl && url ? (
        <Text className="mt-1 block font-mono text-[11px] text-neutral-600">
          Local {server.localUrl}
        </Text>
      ) : null}
    </div>
  );
}
