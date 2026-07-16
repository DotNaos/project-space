import { useEffect, useRef, useState } from 'react';
import { Spinner } from '@heroui/react';
import { CircleAlert, Monitor, MonitorOff, Radio, WifiOff } from 'lucide-react';
import { Chip, Text } from '@/app/dotnaos-ui';
import type {
  CodexSessionBrowserResult,
  CodexSessionBrowserRequest,
  CodexSessionReadRequest
} from '@/shared/codex-sessions-api';

export type CodexBrowserMirrorState =
  | { kind: 'checking' }
  | { kind: 'disconnected'; reason: string }
  | { kind: 'offline'; reason: string }
  | { kind: 'reconnecting'; previous: CodexSessionBrowserResult; reason: string }
  | { kind: 'result'; result: CodexSessionBrowserResult }
  | { kind: 'unauthorized'; reason: string };

function errorStatus(error: unknown) {
  return typeof error === 'object' && error !== null && 'status' in error
    ? Number(error.status)
    : undefined;
}

export function mergeCodexBrowserResult(
  result: CodexSessionBrowserResult,
  previous?: CodexSessionBrowserResult
) {
  const previousImage = previous && (previous.state === 'live' || previous.state === 'ended')
    ? previous.imageDataUrl
    : undefined;
  if (!result.imageUnchanged || !previousImage || result.imageRevision !== previous?.imageRevision) {
    return result;
  }
  const { imageUnchanged: _unchanged, ...rest } = result;
  return { ...rest, imageDataUrl: previousImage } as CodexSessionBrowserResult;
}

export function useCodexBrowserMirror({
  enabled,
  load,
  origin,
  pollIntervalMs = 1_800
}: {
  enabled: boolean;
  load(request: CodexSessionBrowserRequest): Promise<CodexSessionBrowserResult>;
  origin: CodexSessionReadRequest;
  pollIntervalMs?: number;
}) {
  const [state, setState] = useState<CodexBrowserMirrorState>({ kind: 'checking' });
  const latestResult = useRef<CodexSessionBrowserResult | undefined>(undefined);
  const key = `${origin.machineId}\u0000${origin.threadId}`;

  useEffect(() => {
    latestResult.current = undefined;
    setState({ kind: 'checking' });
  }, [key]);

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function refresh() {
      try {
        const previous = latestResult.current;
        const result = await load({
          ...(previous?.imageRevision ? { afterImageRevision: previous.imageRevision } : {}),
          ...origin
        });
        if (stopped) return;
        const next = mergeCodexBrowserResult(result, previous);
        latestResult.current = next;
        setState({ kind: 'result', result: next });
      } catch (error) {
        if (stopped) return;
        const reason = error instanceof Error ? error.message : 'The browser mirror disconnected.';
        const status = errorStatus(error);
        if (status === 401 || status === 403) {
          setState({ kind: 'unauthorized', reason });
        } else if (latestResult.current) {
          setState({ kind: 'reconnecting', previous: latestResult.current, reason });
        } else if (status === 503 || (typeof navigator !== 'undefined' && !navigator.onLine)) {
          setState({ kind: 'offline', reason });
        } else {
          setState({ kind: 'disconnected', reason });
        }
      } finally {
        if (!stopped) timer = setTimeout(refresh, pollIntervalMs);
      }
    }

    void refresh();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [enabled, key, load, origin, pollIntervalMs]);

  return state;
}

export function browserMirrorHasActivity(state: CodexBrowserMirrorState) {
  const result = state.kind === 'result'
    ? state.result
    : state.kind === 'reconnecting'
      ? state.previous
      : undefined;
  return Boolean(result && result.state !== 'never-used' && result.state !== 'unavailable');
}

function MirrorMessage({
  icon: Icon,
  message,
  title
}: {
  icon: typeof Monitor;
  message: string;
  title: string;
}) {
  return (
    <div className="grid h-full min-h-48 place-items-center bg-neutral-950 px-8 text-center">
      <div className="max-w-sm">
        <Icon className="mx-auto size-5 text-neutral-600" />
        <Text className="mt-3 block text-sm font-medium text-neutral-200">{title}</Text>
        <Text className="mt-1 block text-[11px] leading-5 text-neutral-500">{message}</Text>
      </div>
    </div>
  );
}

export function CodexBrowserPane({
  state,
  taskTitle
}: {
  state: CodexBrowserMirrorState;
  taskTitle: string;
}) {
  const result = state.kind === 'result'
    ? state.result
    : state.kind === 'reconnecting'
      ? state.previous
      : undefined;
  const live = result?.state === 'live';
  const ended = result?.state === 'ended';
  const pageUrl = live || ended ? result.pageUrl : undefined;

  return (
    <section
      aria-label={`${taskTitle} browser mirror`}
      className="flex size-full min-h-0 min-w-0 flex-col overflow-hidden bg-neutral-950"
      data-browser-mirror-state={state.kind === 'result' ? state.result.state : state.kind}
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-neutral-800/80 px-3">
        <Monitor className="size-3.5 text-neutral-400" />
        <Text className="text-[11px] font-medium text-neutral-200">
          {live ? 'Browser live' : ended ? 'Browser ended' : 'Browser'}
        </Text>
        {pageUrl ? (
          <Text className="min-w-0 flex-1 truncate font-mono text-[9px] text-neutral-600">
            {pageUrl}
          </Text>
        ) : <span className="flex-1" />}
        {state.kind === 'reconnecting' ? (
          <span className="inline-flex items-center gap-1.5 text-[9px] text-amber-300">
            <Spinner color="warning" size="sm" /> Reconnecting
          </span>
        ) : live ? (
          <span className="inline-flex items-center gap-1.5 text-[9px] text-emerald-300">
            <Radio className="size-3" /> Live
          </span>
        ) : null}
        <Chip className="text-[9px]" size="sm">Read-only</Chip>
      </header>

      <div className="relative min-h-0 flex-1 overflow-hidden bg-black">
        {state.kind === 'checking' ? (
          <div className="grid size-full place-items-center"><Spinner size="lg" /></div>
        ) : state.kind === 'unauthorized' ? (
          <MirrorMessage icon={CircleAlert} message={state.reason} title="Browser access is not authorized" />
        ) : state.kind === 'offline' ? (
          <MirrorMessage icon={WifiOff} message={state.reason} title="The owning connector is offline" />
        ) : state.kind === 'disconnected' ? (
          <MirrorMessage icon={MonitorOff} message={state.reason} title="Browser mirror disconnected" />
        ) : result?.state === 'loading' ? (
          <div className="grid size-full place-items-center gap-3 text-center">
            <span><Spinner size="lg" /></span>
            <Text className="text-[11px] text-neutral-500">Opening the live browser mirror…</Text>
          </div>
        ) : (live || ended) && result.imageDataUrl ? (
          <img
            alt={`${taskTitle} ${live ? 'live browser' : 'ended browser final frame'}`}
            className="pointer-events-none size-full select-none object-contain"
            draggable={false}
            referrerPolicy="no-referrer"
            src={result.imageDataUrl}
          />
        ) : ended ? (
          <MirrorMessage
            icon={MonitorOff}
            message="This turn's browser session has ended. Project Space will not show its last frame as live content."
            title="Browser session ended"
          />
        ) : result?.state === 'never-used' ? (
          <MirrorMessage icon={MonitorOff} message="This turn has not used a browser." title="No browser activity yet" />
        ) : (
          <MirrorMessage
            icon={MonitorOff}
            message={result?.reason ?? 'The browser session is no longer available.'}
            title="Browser no longer available"
          />
        )}
        {state.kind === 'reconnecting' && live && result.imageDataUrl ? (
          <div className="absolute inset-0 grid place-items-center bg-black/55 backdrop-blur-[1px]">
            <span className="inline-flex items-center gap-2 rounded-full bg-neutral-950/90 px-3 py-2 text-[10px] text-amber-200">
              <Spinner color="warning" size="sm" /> Reconnecting to the live mirror
            </span>
          </div>
        ) : null}
        {ended && result.imageDataUrl ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-black/90 to-transparent px-4 pb-4 pt-10">
            <span className="rounded-full bg-neutral-950/90 px-3 py-1.5 text-[10px] text-neutral-300">
              Browser session ended · final read-only frame
            </span>
          </div>
        ) : null}
        <div aria-hidden="true" className="absolute inset-0" data-browser-input="blocked" />
      </div>
    </section>
  );
}
