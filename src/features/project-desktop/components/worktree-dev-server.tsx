import { useEffect, useState } from 'react';
import {
  Check,
  Copy,
  ExternalLink,
  LoaderCircle,
  Play,
  RotateCcw,
  Square,
  X
} from 'lucide-react';

import { Button, Text } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import type {
  MachineMembershipAccess,
  WorktreeDevServerRecord
} from '@/shared/project-space-api';
import {
  registeredDevServerUrl,
  visibleTailscaleUrl
} from './worktree-dev-server-model';

export { registeredDevServerUrl, visibleTailscaleUrl } from './worktree-dev-server-model';

function copyTextWithSelection(value: string) {
  const input = document.createElement('textarea');
  input.value = value;
  input.readOnly = true;
  input.style.position = 'fixed';
  input.style.opacity = '0';
  input.style.pointerEvents = 'none';
  document.body.append(input);
  input.select();
  input.setSelectionRange(0, value.length);

  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    input.remove();
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
  isDisabled,
  isPending,
  onStart,
  onStop,
  server
}: {
  access?: MachineMembershipAccess;
  isChecking: boolean;
  isDisabled?: boolean;
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
      <Button
        aria-label={`${server.state === 'stopping' ? 'Stopping' : 'Starting'} ${server.serverLabel}`}
        size="sm"
        variant="ghost"
        isDisabled
        title={`${server.state === 'stopping' ? 'Stopping' : 'Starting'} ${server.serverLabel}`}
      >
        <LoaderCircle className="size-3.5 animate-spin" />
        <span className="max-w-32 truncate">
          {server.state === 'stopping' ? 'Stopping' : 'Starting'} {server.serverLabel}
        </span>
      </Button>
    );
  }

  if (server.state === 'running') {
    return (
      <Button
        aria-label={`Stop ${server.serverLabel}`}
        size="sm"
        variant="ghost"
        isDisabled={isDisabled}
        onPress={onStop}
        title={`Stop ${server.serverLabel}`}
        className="text-red-300 hover:bg-red-500/10 hover:text-red-200"
      >
        <Square className="size-3" />
        <span className="max-w-32 truncate">Stop {server.serverLabel}</span>
      </Button>
    );
  }

  const retry = server.state === 'error';
  return (
    <Button
      aria-label={`${retry ? 'Retry' : 'Start'} ${server.serverLabel}`}
      size="sm"
      variant={retry ? 'secondary' : 'primary'}
      isDisabled={isDisabled}
      onPress={onStart}
      title={`${retry ? 'Retry' : 'Start'} ${server.serverLabel}`}
      className={retry ? 'border-amber-400/30 bg-amber-400/15 text-amber-100 hover:bg-amber-400/25' : 'bg-violet-500 text-white hover:bg-violet-400'}
    >
      {retry ? <RotateCcw className="size-3.5" /> : <Play className="size-3.5 fill-current" />}
      <span className="max-w-32 truncate">
        {retry ? 'Retry' : 'Start'} {server.serverLabel}
      </span>
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
  const [copyState, setCopyState] = useState<
    'idle' | 'copying' | 'copied' | 'error'
  >('idle');
  const [, setFreshnessTick] = useState(0);
  const url = visibleTailscaleUrl(server);
  const registeredUrl = registeredDevServerUrl(server);

  useEffect(() => {
    setCopyState('idle');
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
    (server.state === 'stopped' && !server.lastError && !registeredUrl && !server.localUrl)
  ) {
    return null;
  }

  async function copyUrl() {
    if (!url) {
      return;
    }

    setCopyState('copying');
    let copied = false;
    let timeout = 0;
    try {
      const clipboardWrite = navigator.clipboard?.writeText
        ? navigator.clipboard.writeText(url)
        : Promise.reject(new Error('Clipboard API is unavailable.'));
      await Promise.race([
        clipboardWrite,
        new Promise<never>((_, reject) => {
          timeout = window.setTimeout(
            () => reject(new Error('Clipboard write timed out.')),
            750
          );
        })
      ]);
      copied = true;
    } catch {
      copied = copyTextWithSelection(url);
    } finally {
      window.clearTimeout(timeout);
    }
    setCopyState(copied ? 'copied' : 'error');
    window.setTimeout(() => setCopyState('idle'), 2_000);
  }

  return (
    <div
      aria-label={`${server.serverLabel} development server`}
      aria-live="polite"
      className="ml-10 mr-3 border-l border-neutral-800 px-3 pb-3 pt-1 text-xs"
    >
      <div className="flex min-w-0 flex-col items-start gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3">
        <span
          className="max-w-full truncate font-semibold text-neutral-200 sm:max-w-48"
          title={server.serverLabel}
        >
          {server.serverLabel}
        </span>
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
          <div className="flex w-full min-w-0 items-center gap-1.5 sm:w-auto">
            <a
              aria-label={`Open ${server.serverLabel}`}
              href={url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-lg bg-emerald-500 px-2.5 font-medium text-white transition hover:bg-emerald-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/70"
            >
              <ExternalLink className="size-3.5" />
              Open
            </a>
            <a
              aria-label={`Open ${server.serverLabel} at ${url}`}
              href={url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-w-0 flex-1 items-center gap-1.5 font-mono text-neutral-100 underline decoration-neutral-700 underline-offset-4 transition hover:decoration-neutral-200 sm:flex-initial"
            >
              <span className="min-w-0 flex-1 truncate sm:max-w-[24rem]">{url}</span>
              <ExternalLink className="-order-1 size-3.5 shrink-0 sm:order-none" />
            </a>
            <Button
              aria-label={
                copyState === 'copied'
                  ? `${server.serverLabel} Tailscale URL copied`
                  : copyState === 'copying'
                    ? `Copying ${server.serverLabel} Tailscale URL`
                    : copyState === 'error'
                      ? `Could not copy ${server.serverLabel} Tailscale URL`
                      : `Copy ${server.serverLabel} Tailscale URL`
              }
              size="sm"
              variant="ghost"
              isIconOnly
              onPress={() => void copyUrl()}
              className="-order-1 min-h-7 shrink-0 sm:order-none"
            >
              {copyState === 'copying' ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : copyState === 'copied' ? (
                <Check className="size-3.5" />
              ) : copyState === 'error' ? (
                <X className="size-3.5 text-red-300" />
              ) : (
                <Copy className="size-3.5" />
              )}
            </Button>
          </div>
        ) : registeredUrl ? (
          <a
            aria-label={`Open registered URL for ${server.serverLabel}`}
            href={registeredUrl}
            target="_blank"
            rel="noreferrer"
            className="flex w-full min-w-0 items-center gap-1.5 rounded-sm text-neutral-300 underline decoration-neutral-700 underline-offset-4 transition hover:decoration-neutral-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/70 sm:w-auto"
          >
            <ExternalLink className="size-3.5 shrink-0 text-neutral-500" />
            <span className="shrink-0 text-neutral-500">Registered URL</span>
            <span className="min-w-0 truncate font-mono text-neutral-300 sm:max-w-[24rem]">
              {registeredUrl}
            </span>
          </a>
        ) : null}
      </div>

      {server.lastError ? (
        <Text className="mt-1.5 block max-w-3xl text-red-300/80">{server.lastError}</Text>
      ) : null}
      {server.localUrl && server.localUrl !== registeredUrl ? (
        <Text className="mt-1 block truncate font-mono text-[11px] text-neutral-600">
          Local {server.localUrl}
        </Text>
      ) : null}
    </div>
  );
}
