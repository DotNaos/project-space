import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import {
  ProjectTopologyPreviewStream,
  type TopologyPreviewStreamClient,
  type TopologyPreviewStreamOptions,
  type TopologyPreviewStreamState
} from './project-topology-preview-stream';
import type {
  TopologyInventoryResult,
  TopologyTask,
  TopologyTranscriptItem
} from './project-topology-types';

export interface ProjectTopologyTranscriptBinding {
  getState(): TopologyPreviewStreamState;
  retain(task: TopologyTask): () => void;
  subscribe(listener: () => void): () => void;
}

interface RegistryEntry {
  binding: ProjectTopologyTranscriptBinding;
  dispose(): void;
}

export class ProjectTopologyTranscriptRegistry {
  private disposed = false;
  private readonly entries = new Map<string, RegistryEntry>();

  constructor(
    private readonly client: TopologyPreviewStreamClient,
    private readonly options: TopologyPreviewStreamOptions = {}
  ) {}

  binding(task: TopologyTask): ProjectTopologyTranscriptBinding | undefined {
    if (this.disposed) return undefined;
    const existing = this.entries.get(task.id);
    if (existing) return existing.binding;
    const entry = createRegistryEntry(this.client, this.options);
    this.entries.set(task.id, entry);
    return entry.binding;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.entries.values()) entry.dispose();
    this.entries.clear();
  }
}

export function useTopologyLiveTranscript(
  registry: ProjectTopologyTranscriptRegistry | undefined,
  task: TopologyTask,
  active: boolean,
  onAuthorityInvalidated?: () => void
) {
  const binding = useMemo(() => registry?.binding(task), [registry, task.id]);
  const subscribe = useMemo(() => binding
    ? binding.subscribe
    : () => () => undefined, [binding]);
  const getState = useMemo(() => binding
    ? binding.getState
    : () => inactiveState, [binding]);
  const state = useSyncExternalStore(subscribe, getState, getState);
  const identityVersion = liveIdentityVersion(task);
  const taskRef = useRef(task);
  const invalidationCallbackRef = useRef(onAuthorityInvalidated);
  const notifiedInvalidationRef = useRef<string | undefined>(undefined);
  const notifiedGenerationMismatchRef = useRef<string | undefined>(undefined);
  const generationMismatchKey = topologyLiveTranscriptGenerationMismatchKey(task, state);
  const canReconcile = Boolean(onAuthorityInvalidated);
  taskRef.current = task;
  invalidationCallbackRef.current = onAuthorityInvalidated;

  useEffect(() => {
    if (!active || !binding) return;
    return binding.retain(taskRef.current);
  }, [active, binding, identityVersion]);
  useEffect(() => {
    const eventId = state.authorityInvalidation?.eventId;
    if (
      !active
      || !eventId
      || eventId === notifiedInvalidationRef.current
      || !invalidationCallbackRef.current
    ) return;
    notifiedInvalidationRef.current = eventId;
    invalidationCallbackRef.current();
  }, [active, state.authorityInvalidation?.eventId]);
  useEffect(() => {
    if (!active || !canReconcile) {
      if (!active) notifiedGenerationMismatchRef.current = undefined;
      return;
    }
    notifiedGenerationMismatchRef.current = reconcileLiveTranscriptGeneration(
      notifiedGenerationMismatchRef.current,
      generationMismatchKey,
      () => invalidationCallbackRef.current?.()
    );
  }, [active, canReconcile, generationMismatchKey]);

  return active && binding
    ? topologyTaskWithLiveTranscript(task, state)
    : task;
}

export function reconcileLiveTranscriptGeneration(
  previousKey: string | undefined,
  mismatchKey: string | null | undefined,
  onMismatch: () => void
) {
  if (mismatchKey === undefined) return previousKey;
  if (mismatchKey === null) return undefined;
  if (mismatchKey !== previousKey) onMismatch();
  return mismatchKey;
}

export function topologyTaskWithLiveTranscript(
  task: TopologyTask,
  state: TopologyPreviewStreamState
): TopologyTask {
  const data = state.items.map<TopologyTranscriptItem>((item, order) => ({
    ...item,
    order,
    ...(item.turnId ? { turnId: item.turnId } : {}),
    ...(item.turnStatus ? { turnStatus: item.turnStatus } : {})
  }));
  const transcript = liveTranscriptInventory(state, data, task.transcript);
  const session = liveSession(task, state);
  const liveCurrent = state.state === 'ready'
    && !state.authorityInvalidation
    && Boolean(session)
    && sameSessionGeneration(task, session!);
  const reason = state.authorityInvalidation?.reason
    ?? (transcript.state === 'ready'
      ? 'The live task identity no longer matches the writable snapshot.'
      : transcript.state === 'checking'
        ? 'The live transcript is still checking.'
        : transcript.reason);
  return {
    ...task,
    activity: liveActivity(task, state, session),
    interaction: liveCurrent
      ? task.interaction
      : {
          canContinue: false,
          canInterrupt: false,
          composerVisible: false,
          reason
        },
    ...(session ? { session } : {}),
    transcript
  };
}

function liveTranscriptInventory(
  state: TopologyPreviewStreamState,
  data: TopologyTranscriptItem[],
  fallback: TopologyInventoryResult<TopologyTranscriptItem[]>
): TopologyInventoryResult<TopologyTranscriptItem[]> {
  if (state.state === 'ready') {
    return { checkedAt: state.checkedAt, data, state: 'ready' };
  }
  if (state.state === 'stale') {
    const retained = data.length > 0 ? data : safeTranscriptData(fallback);
    const lastSafeAt = state.lastSafeAt ?? safeTranscriptAt(fallback);
    if (!lastSafeAt) {
      return { reason: state.reason, state: 'blocked' };
    }
    return {
      data: retained,
      lastSafeAt,
      reason: state.reason,
      state: 'stale'
    };
  }
  if (state.state === 'blocked') {
    const retained = safeTranscriptData(fallback);
    const lastSafeAt = safeTranscriptAt(fallback);
    return lastSafeAt
      ? { data: retained, lastSafeAt, reason: state.reason, state: 'stale' }
      : { reason: state.reason, state: 'blocked' };
  }
  if (state.lastSafeAt) {
    return {
      data,
      lastSafeAt: state.lastSafeAt,
      reason: 'The live transcript is reconnecting.',
      state: 'stale'
    };
  }
  const retained = safeTranscriptData(fallback);
  const lastSafeAt = safeTranscriptAt(fallback);
  if (lastSafeAt) {
    return {
      data: retained,
      lastSafeAt,
      reason: 'The live transcript is reconnecting.',
      state: 'stale'
    };
  }
  return { state: 'checking' };
}

function liveSession(task: TopologyTask, state: TopologyPreviewStreamState) {
  const session = state.session;
  const sessionAt = Date.parse(session?.lastActivityAt ?? '');
  const taskAt = Date.parse(task.session.lastActivityAt);
  if (
    !session
    || session.machineId !== task.machineId
    || session.id !== task.threadId
    || !Number.isFinite(sessionAt)
    || !Number.isFinite(taskAt)
    || sessionAt < taskAt
  ) return undefined;
  const status = state.sessionStatus ?? session.status;
  return {
    ...session,
    archived: status === 'archived' || session.archived,
    status
  };
}

function sameSessionGeneration(
  task: TopologyTask,
  session: TopologyTask['session']
) {
  return session.machineId === task.session.machineId
    && session.id === task.session.id
    && session.lastActivityAt === task.session.lastActivityAt
    && session.status === task.session.status
    && session.archived === task.session.archived;
}

export function topologyLiveTranscriptGenerationMismatchKey(
  task: TopologyTask,
  state: TopologyPreviewStreamState
): string | null | undefined {
  const session = state.session;
  if (
    state.state !== 'ready'
    || state.authorityInvalidation
    || !session
    || session.machineId !== task.machineId
    || session.id !== task.threadId
  ) return undefined;
  const status = state.sessionStatus ?? session.status;
  const candidate = {
    ...session,
    archived: status === 'archived' || session.archived,
    status
  };
  if (sameSessionGeneration(task, candidate)) return null;
  return [
    task.session.lastActivityAt,
    task.session.status,
    task.session.archived ? 'archived' : 'open',
    candidate.lastActivityAt,
    candidate.status,
    candidate.archived ? 'archived' : 'open'
  ].join('\u0000');
}

function liveActivity(
  task: TopologyTask,
  state: TopologyPreviewStreamState,
  session: TopologyTask['session'] | undefined
): TopologyTask['activity'] {
  if (state.awaitingDecision) return 'awaiting-decision';
  if (state.state === 'stale' || state.state === 'checking') return 'stale';
  if (state.state === 'blocked') return 'blocked';
  if (!session) return 'stale';
  if (session.status === 'active') return 'active';
  if (session.status === 'idle') return 'idle-unverified';
  if (session.status === 'archived') return 'archived';
  if (session.status === 'offline') return 'offline';
  if (session.status === 'missing' || session.status === 'unavailable') return 'blocked';
  return task.activity;
}

function safeTranscriptData(
  transcript: TopologyInventoryResult<TopologyTranscriptItem[]>
) {
  return transcript.state === 'ready' || transcript.state === 'stale'
    ? transcript.data
    : [];
}

function safeTranscriptAt(
  transcript: TopologyInventoryResult<TopologyTranscriptItem[]>
) {
  return transcript.state === 'ready'
    ? transcript.checkedAt
    : transcript.state === 'stale'
      ? transcript.lastSafeAt
      : undefined;
}

function createRegistryEntry(
  client: TopologyPreviewStreamClient,
  options: TopologyPreviewStreamOptions
): RegistryEntry {
  const stream = new ProjectTopologyPreviewStream(client, options);
  let currentTask: TopologyTask | undefined;
  let references = 0;
  let disposed = false;
  const binding: ProjectTopologyTranscriptBinding = {
    getState: () => stream.getState(),
    retain(task) {
      if (disposed) return () => undefined;
      const wasInactive = references === 0;
      references += 1;
      if (wasInactive || !currentTask || shouldReplaceTask(currentTask, task)) {
        currentTask = task;
        stream.start(task);
      }
      let released = false;
      return () => {
        if (released || disposed) return;
        released = true;
        references = Math.max(0, references - 1);
        if (references === 0) stream.stop();
      };
    },
    subscribe(listener) {
      return stream.listen(() => listener());
    }
  };
  return {
    binding,
    dispose() {
      if (disposed) return;
      disposed = true;
      references = 0;
      stream.dispose();
    }
  };
}

function shouldReplaceTask(current: TopologyTask, candidate: TopologyTask) {
  if (liveIdentityVersion(current) === liveIdentityVersion(candidate)) return false;
  const currentAt = Date.parse(current.session.lastActivityAt);
  const candidateAt = Date.parse(candidate.session.lastActivityAt);
  if (Number.isFinite(currentAt) && Number.isFinite(candidateAt) && candidateAt < currentAt) {
    return false;
  }
  return true;
}

function liveIdentityVersion(task: TopologyTask) {
  return [
    task.id,
    task.machineId,
    task.threadId,
    task.session.lastActivityAt,
    task.session.status,
    task.session.archived ? 'archived' : 'open',
    task.cwd,
    task.evidence.current ? 'current' : 'stale',
    task.evidence.matchedPath
  ].join('\u0000');
}

const inactiveState: TopologyPreviewStreamState = { items: [], state: 'checking' };
