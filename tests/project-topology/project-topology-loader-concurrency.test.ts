import { describe, expect, test } from 'bun:test';
import type { ProjectSpaceRecord } from '@/shared/project-space-api';
import {
  loadProjectTopologyInventory,
  loadProjectTopologyTaskDetails,
  type ProjectTopologySource
} from '../../src/features/project-topology/project-topology-loader';
import { buildProjectTopology } from '../../src/features/project-topology/project-topology-model';
import {
  checkedAt,
  codex,
  conversation,
  location,
  machine,
  project,
  repositoryDetails,
  session,
  snapshot,
  writable,
  worktrees
} from './project-topology-test-fixtures';

type SourcePhase = 'detail' | 'inventory' | 'location';
type SourceMethod = 'codex' | 'deployment' | 'evidence' | 'location'
  | 'read' | 'repository' | 'worktree' | 'write';
type BeforeSourceCall = (phase: SourcePhase, method: SourceMethod) => Promise<void>;

describe('project topology loader scheduling', () => {
  test('shares a six-call budget across heterogeneous sources in each phase', async () => {
    const tracker = sourceTracker();
    const { source } = observedSource(8, tracker.beforeCall);

    await loadProjectTopologyInventory(source, { clock: () => checkedAt });

    expect(tracker.peak).toEqual({ detail: 6, inventory: 6, location: 6 });
    expect(tracker.callCount('worktree')).toBe(8);
    expect(tracker.callCount('repository')).toBe(8);
    expect(tracker.callCount('deployment')).toBe(8);
    expect(tracker.callCount('codex')).toBe(8);
    expect(tracker.callCount('read')).toBe(8);
    expect(tracker.callCount('write')).toBe(0);
    expect(tracker.callCount('evidence')).toBe(8);
  });

  test('does not start queued source calls after cancellation', async () => {
    const controller = new AbortController();
    const startedSix = deferred<void>();
    const release = deferred<void>();
    let calls = 0;
    let callsAfterAbort = 0;
    const { source } = observedSource(12, async (phase) => {
      if (phase !== 'inventory') return;
      calls += 1;
      if (controller.signal.aborted) callsAfterAbort += 1;
      if (calls === 6) startedSix.resolve();
      await release.promise;
    });
    const loading = loadProjectTopologyInventory(source, {
      clock: () => checkedAt,
      includeTranscripts: false,
      signal: controller.signal
    });

    await startedSix.promise;
    controller.abort();
    release.resolve();
    await loading;

    expect(calls).toBe(6);
    expect(callsAfterAbort).toBe(0);
  });

  test('ages every early ready inventory envelope after a slow downstream source', async () => {
    let now = Date.parse(checkedAt);
    const { source } = observedSource(2, async (phase) => {
      if (phase === 'location') now += 31_000;
    }, ['machine-1']);

    const inventory = await loadProjectTopologyInventory(source, {
      clock: () => new Date(now).toISOString(),
      includeTranscripts: false
    });
    const worktreeResults = Object.values(inventory.worktreesByProjectScope);
    const repositoryResults = Object.values(inventory.repositoriesByFullName);
    const deploymentResults = Object.values(inventory.deploymentsByRepository);
    const codexResults = Object.values(inventory.codexByMachineId);

    expect(inventory.checkedAt).toBe('2026-07-14T00:00:31.000Z');
    expect(inventory.projects).toMatchObject({ lastSafeAt: checkedAt, state: 'stale' });
    expect(inventory.machines).toMatchObject({ lastSafeAt: checkedAt, state: 'stale' });
    expect(worktreeResults).toHaveLength(2);
    expect(repositoryResults).toHaveLength(2);
    expect(deploymentResults).toHaveLength(2);
    expect(codexResults).toHaveLength(2);
    expect(worktreeResults.every((result) => result.state === 'stale')).toBe(true);
    expect(repositoryResults.every((result) => result.state === 'stale')).toBe(true);
    expect(deploymentResults.every((result) => result.state === 'stale')).toBe(true);
    expect(codexResults.every((result) => result.state === 'stale')).toBe(true);
    const emptyCodex = inventory.codexByMachineId['machine-1'];
    expect(emptyCodex).toMatchObject({ lastSafeAt: checkedAt, state: 'stale' });
    if (emptyCodex?.state === 'stale') expect(emptyCodex.data.sessions).toHaveLength(0);
    const emptyMachine = snapshot(buildProjectTopology(inventory)).projects.flatMap((entry) => (
      entry.machines
    )).find((entry) => entry.id === 'machine-1');
    expect(emptyMachine?.taskInventory.state).toBe('stale');
    expect(Object.keys(inventory.taskLocationsByTaskId ?? {})).toHaveLength(0);
  });

  test('ages early transcripts without minting overview write authority', async () => {
    let now = Date.parse(checkedAt);
    let evidenceCalls = 0;
    const { source } = observedSource(7, async (phase, method) => {
      if (phase === 'detail' && method === 'evidence') {
        evidenceCalls += 1;
        if (evidenceCalls === 7) now += 31_000;
      }
    });
    const clock = () => new Date(now).toISOString();
    const base = await loadProjectTopologyInventory(source, {
      clock,
      includeTranscripts: false
    });

    const detailed = await loadProjectTopologyTaskDetails(source, base, { clock });
    const conversations = Object.values(detailed.conversationsByTaskId ?? {});
    const capabilities = Object.values(detailed.writeCapabilitiesByTaskId ?? {});

    expect(detailed.checkedAt).toBe('2026-07-14T00:00:31.000Z');
    expect(conversations).toHaveLength(7);
    expect(conversations.every((result) => (
      result.state === 'stale' && result.lastSafeAt === checkedAt
    ))).toBe(true);
    expect(capabilities).toHaveLength(0);
    expect(Object.keys(detailed.taskLocationsByTaskId ?? {})).toHaveLength(0);
  });
});

function observedSource(
  count: number,
  beforeCall: BeforeSourceCall,
  emptyMachineIds: string[] = []
) {
  const machines = Array.from({ length: count }, (_, index) => machine(`machine-${index}`));
  const projects = machines.map((entry, index) => project(
    `project-${index}`,
    entry.id,
    `/projects/repo-${index}`,
    `DotNaos/repo-${index}`
  ));
  const sessions = machines.map((entry, index) => session(
    entry.id,
    `thread-${index}`,
    `/projects/repo-${index}/src`,
    'active'
  ));
  const findSession = (machineId: string, threadId: string) => sessions.find((entry) => (
    entry.machineId === machineId && entry.id === threadId
  ))!;
  const source: ProjectTopologySource = {
    async discoverProjectWorktrees(projectId, machineId) {
      await beforeCall('inventory', 'worktree');
      const record = projects.find((entry) => (
        entry.id === projectId && entry.machineId === machineId
      ));
      return worktrees(record?.rootPath ?? '/unknown', []);
    },
    async getConnectorOverview() {
      return ready({
        machines,
        machinesRepo: { exists: true, path: '/machines' },
        tailscale: {
          connected: true, installed: true, ips: [], peersOnline: 0, serveOrigins: []
        }
      });
    },
    async getDeployedEnvironmentStatus(repositoryFullName) {
      await beforeCall('inventory', 'deployment');
      return ready({
        checkedAt, environments: [], repositoryFullName, status: 'available'
      });
    },
    async getGitHubRepositoryDetails() {
      await beforeCall('inventory', 'repository');
      return ready(repositoryDetails('main'));
    },
    async listCodexSessions(machineId) {
      await beforeCall('inventory', 'codex');
      const machineSessions = emptyMachineIds.includes(machineId)
        ? []
        : sessions.filter((entry) => entry.machineId === machineId);
      return ready(codex(machineId, machineSessions));
    },
    async loadProjectDiscovery() {
      return ready(projectDiscovery(projects));
    },
    async readCodexSession(machineId, threadId) {
      await beforeCall('detail', 'read');
      return ready(conversation(findSession(machineId, threadId)));
    },
    async resolveCodexSessionLocation(machineId, threadId) {
      await beforeCall('location', 'location');
      const record = projects.find((candidate) => candidate.machineId === machineId);
      return ready(location(
        findSession(machineId, threadId),
        undefined,
        record?.rootPath
      ));
    },
    async getCodexSessionWriteCapability(machineId, threadId) {
      await beforeCall('detail', 'write');
      return writable(findSession(machineId, threadId));
    },
    async getCodexSessionTaskEvidence(machineId, threadId) {
      await beforeCall('detail', 'evidence');
      return { machineId, threadId };
    }
  };
  return { source };
}

function sourceTracker() {
  const active: Record<SourcePhase, number> = { detail: 0, inventory: 0, location: 0 };
  const peak: Record<SourcePhase, number> = { detail: 0, inventory: 0, location: 0 };
  const calls = new Map<SourceMethod, number>();
  return {
    async beforeCall(phase: SourcePhase, method: SourceMethod) {
      calls.set(method, (calls.get(method) ?? 0) + 1);
      active[phase] += 1;
      peak[phase] = Math.max(peak[phase], active[phase]);
      try {
        await Promise.resolve();
      } finally {
        active[phase] -= 1;
      }
    },
    callCount(method: SourceMethod) {
      return calls.get(method) ?? 0;
    },
    peak
  };
}

function projectDiscovery(projects: ProjectSpaceRecord[]) {
  return {
    groups: [], projects, rootItems: [], rootPath: '/projects', structureViolations: []
  };
}

function ready<T>(data: T) {
  return { checkedAt, data, state: 'ready' as const };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}
