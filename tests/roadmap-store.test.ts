import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  LocalRoadmapPlanStore,
  RoadmapStorageCorruption
} from '../server/roadmap/local-roadmap-store';
import {
  InMemoryRoadmapPlanStore,
  PostgresRoadmapPlanStore,
  RoadmapRevisionConflict
} from '../server/roadmap/roadmap-store';
import type { DatabaseQueryClient } from '../server/database/client';
import type { RoadmapDependency } from '../src/shared/roadmap-api';

const temporaryRoots: string[] = [];
const dependency = {
  blocked: { fullName: 'DotNaos/project-space', id: 2, number: 2 },
  blocker: { fullName: 'DotNaos/private', id: 1, number: 1 },
  freshness: 'current'
} satisfies RoadmapDependency;

class RoadmapPostgresClient implements DatabaseQueryClient {
  private plan: unknown = { goals: [], items: [] };
  private revision = 0;

  async query<Row>(sql: string, values: readonly unknown[] = []) {
    if (sql.includes('insert into roadmap_plans')) {
      const expectedRevision = Number(values[3]);
      const canAttemptExistingUpdate = sql.includes('or exists')
        && this.revision === expectedRevision;
      if (expectedRevision !== 0 && !canAttemptExistingUpdate) {
        return { rows: [] as Row[] };
      }
      if (this.revision !== expectedRevision) return { rows: [] as Row[] };
      this.revision += 1;
      this.plan = JSON.parse(String(values[2]));
      return { rows: [this.row() as Row] };
    }
    if (sql.includes('from roadmap_plans plans')) {
      return { rows: this.revision > 0 ? [this.row() as Row] : [] };
    }
    throw new Error(`Unexpected roadmap test query: ${sql}`);
  }

  private row() {
    return {
      dependency_checked_at: null,
      dependency_snapshot: [],
      plan: this.plan,
      plan_updated_at: '2026-07-21T00:00:00.000Z',
      repository_full_name: 'DotNaos/project-space',
      repository_id: 42,
      revision: this.revision
    };
  }
}

afterEach(() => {
  temporaryRoots.splice(0).forEach((path) => rmSync(path, { force: true, recursive: true }));
});

describe('roadmap stores', () => {
  test('updates an existing PostgreSQL plan beyond its first revision', async () => {
    const store = new PostgresRoadmapPlanStore(new RoadmapPostgresClient());
    const input = {
      expectedRevision: 0,
      goals: [],
      items: [],
      repositoryFullName: 'DotNaos/project-space',
      repositoryId: 42
    };
    await expect(store.updatePlan(input)).resolves.toMatchObject({ revision: 1 });
    await expect(store.updatePlan({
      ...input,
      expectedRevision: 1,
      goals: [{ id: 'preview', title: 'Preview deployments' }]
    })).resolves.toMatchObject({
      goals: [{ id: 'preview', title: 'Preview deployments' }],
      revision: 2
    });
    await expect(store.updatePlan({
      ...input,
      expectedRevision: 1
    })).rejects.toMatchObject({
      current: { revision: 2 }
    });
  });

  test('uses compare-and-swap for concurrent plan writers', async () => {
    const store = new InMemoryRoadmapPlanStore();
    const input = {
      expectedRevision: 0,
      goals: [],
      items: [],
      repositoryFullName: 'DotNaos/project-space',
      repositoryId: 42
    };
    await expect(store.updatePlan(input)).resolves.toMatchObject({ revision: 1 });
    await expect(store.updatePlan(input)).rejects.toBeInstanceOf(RoadmapRevisionConflict);
  });

  test('isolates dependency snapshots by viewer without changing plan revision', async () => {
    const store = new InMemoryRoadmapPlanStore();
    await store.updatePlan({
      expectedRevision: 0,
      goals: [],
      items: [],
      repositoryFullName: 'DotNaos/project-space',
      repositoryId: 42
    });
    await store.saveDependencies(42, 'DotNaos/project-space', 'alice', [dependency], '2026-07-19T00:00:00.000Z');
    await store.saveDependencies(42, 'DotNaos/project-space', 'bob', [], '2026-07-19T00:01:00.000Z');
    expect((await store.read(42, 'alice'))?.dependencies).toEqual([dependency]);
    expect((await store.read(42, 'bob'))?.dependencies).toEqual([]);
    expect((await store.read(42, 'alice'))?.revision).toBe(1);
  });

  test('survives a direct reload from a protected local file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'project-space-roadmap-'));
    temporaryRoots.push(root);
    const path = join(root, 'roadmaps.json');
    const first = new LocalRoadmapPlanStore(path);
    await first.updatePlan({
      expectedRevision: 0,
      goals: [{ id: 'launch', title: 'Launch' }],
      items: [],
      repositoryFullName: 'DotNaos/project-space',
      repositoryId: 42
    });
    await first.saveDependencies(42, 'DotNaos/project-space', 'alice', [dependency], '2026-07-19T00:00:00.000Z');
    const reloaded = new LocalRoadmapPlanStore(path);
    expect(await reloaded.read(42, 'alice')).toMatchObject({
      dependencies: [dependency],
      goals: [{ id: 'launch', title: 'Launch' }],
      revision: 1
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, 'utf8')).version).toBe(1);
  });

  test('refuses to overwrite corrupted local storage', async () => {
    const root = mkdtempSync(join(tmpdir(), 'project-space-roadmap-'));
    temporaryRoots.push(root);
    const path = join(root, 'roadmaps.json');
    writeFileSync(path, '{broken', { mode: 0o600 });
    const store = new LocalRoadmapPlanStore(path);
    await expect(store.updatePlan({
      expectedRevision: 0,
      goals: [],
      items: [],
      repositoryFullName: 'DotNaos/project-space',
      repositoryId: 42
    })).rejects.toBeInstanceOf(RoadmapStorageCorruption);
    expect(readFileSync(path, 'utf8')).toBe('{broken');
  });
});
