import type { DatabaseQueryClient } from '../database/client';
import type {
  RoadmapDependency,
  RoadmapGoal,
  RoadmapPlanItem
} from '../../src/shared/roadmap-api';

export interface StoredRoadmapPlan {
  dependencyCheckedAt?: string;
  dependencies: RoadmapDependency[];
  goals: RoadmapGoal[];
  items: RoadmapPlanItem[];
  repositoryFullName: string;
  repositoryId: number;
  revision: number;
  updatedAt?: string;
}

export interface RoadmapPlanStore {
  read(repositoryId: number, principalId: string): Promise<StoredRoadmapPlan | undefined>;
  saveDependencies(
    repositoryId: number,
    repositoryFullName: string,
    principalId: string,
    dependencies: RoadmapDependency[],
    checkedAt: string
  ): Promise<void>;
  updatePlan(input: {
    expectedRevision: number;
    goals: RoadmapGoal[];
    items: RoadmapPlanItem[];
    repositoryFullName: string;
    repositoryId: number;
  }): Promise<StoredRoadmapPlan>;
}

export class RoadmapRevisionConflict extends Error {
  constructor(readonly current: StoredRoadmapPlan) {
    super('The roadmap plan changed before this update was saved.');
    this.name = 'RoadmapRevisionConflict';
  }
}

interface RoadmapRow {
  dependency_checked_at: Date | string | null;
  dependency_snapshot: unknown;
  plan: unknown;
  repository_full_name: string;
  repository_id: string | number;
  revision: string | number;
  plan_updated_at: Date | string | null;
}

function isoDate(value: Date | string | null | undefined) {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function safePlanPayload(value: unknown) {
  if (!value || typeof value !== 'object') return { goals: [], items: [] };
  const payload = value as { goals?: unknown; items?: unknown };
  return {
    goals: Array.isArray(payload.goals) ? payload.goals as RoadmapGoal[] : [],
    items: Array.isArray(payload.items) ? payload.items as RoadmapPlanItem[] : []
  };
}

function mapRow(row: RoadmapRow): StoredRoadmapPlan {
  const plan = safePlanPayload(row.plan);
  return {
    dependencyCheckedAt: isoDate(row.dependency_checked_at),
    dependencies: Array.isArray(row.dependency_snapshot)
      ? row.dependency_snapshot as RoadmapDependency[]
      : [],
    goals: plan.goals,
    items: plan.items,
    repositoryFullName: row.repository_full_name,
    repositoryId: Number(row.repository_id),
    revision: Number(row.revision),
    updatedAt: isoDate(row.plan_updated_at)
  };
}

export class PostgresRoadmapPlanStore implements RoadmapPlanStore {
  constructor(private readonly client: DatabaseQueryClient) {}

  async read(repositoryId: number, principalId: string) {
    const result = await this.client.query<RoadmapRow>(
      `select plans.repository_id, plans.repository_full_name, plans.revision, plans.plan,
              coalesce(snapshots.dependency_snapshot, '[]'::jsonb) as dependency_snapshot,
              snapshots.dependency_checked_at, plans.plan_updated_at
         from roadmap_plans plans
         left join roadmap_dependency_snapshots snapshots
           on snapshots.repository_id = plans.repository_id
          and snapshots.principal_id = $2
        where plans.repository_id = $1`,
      [repositoryId, principalId]
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async updatePlan(input: {
    expectedRevision: number;
    goals: RoadmapGoal[];
    items: RoadmapPlanItem[];
    repositoryFullName: string;
    repositoryId: number;
  }) {
    const result = await this.client.query<RoadmapRow>(
      `insert into roadmap_plans (
         repository_id, repository_full_name, revision, plan, plan_updated_at, updated_at
       )
       select $1, $2, 1, $3::jsonb, now(), now()
       where $4 = 0
       on conflict (repository_id) do update set
         repository_full_name = excluded.repository_full_name,
         revision = roadmap_plans.revision + 1,
         plan = excluded.plan,
         plan_updated_at = now(),
         updated_at = now()
       where roadmap_plans.revision = $4
       returning repository_id, repository_full_name, revision, plan,
                 '[]'::jsonb as dependency_snapshot,
                 null::timestamptz as dependency_checked_at, plan_updated_at`,
      [
        input.repositoryId,
        input.repositoryFullName,
        JSON.stringify({ goals: input.goals, items: input.items }),
        input.expectedRevision
      ]
    );
    if (result.rows[0]) return mapRow(result.rows[0]);
    const current = await this.read(input.repositoryId, 'conflict');
    if (current) throw new RoadmapRevisionConflict(current);
    throw new Error('Could not save the roadmap plan.');
  }

  async saveDependencies(
    repositoryId: number,
    repositoryFullName: string,
    principalId: string,
    dependencies: RoadmapDependency[],
    checkedAt: string
  ) {
    await this.client.query(
      `insert into roadmap_plans (repository_id, repository_full_name, updated_at)
       values ($1, $2, now())
       on conflict (repository_id) do update set
         repository_full_name = excluded.repository_full_name`,
      [repositoryId, repositoryFullName]
    );
    await this.client.query(
      `insert into roadmap_dependency_snapshots (
         repository_id, principal_id, dependency_snapshot, dependency_checked_at, updated_at
       )
       values ($1, $2, $3::jsonb, $4, now())
       on conflict (repository_id, principal_id) do update set
         dependency_snapshot = excluded.dependency_snapshot,
         dependency_checked_at = excluded.dependency_checked_at,
         updated_at = now()`,
      [repositoryId, principalId, JSON.stringify(dependencies), checkedAt]
    );
  }
}

export class InMemoryRoadmapPlanStore implements RoadmapPlanStore {
  private readonly records = new Map<number, StoredRoadmapPlan>();
  private readonly snapshots = new Map<
    string,
    Pick<StoredRoadmapPlan, 'dependencies' | 'dependencyCheckedAt'>
  >();

  async read(repositoryId: number, principalId: string) {
    const record = this.records.get(repositoryId);
    if (!record) return undefined;
    const snapshot = this.snapshots.get(`${repositoryId}:${principalId}`);
    return structuredClone({
      ...record,
      dependencies: snapshot?.dependencies ?? [],
      dependencyCheckedAt: snapshot?.dependencyCheckedAt
    });
  }

  async updatePlan(input: {
    expectedRevision: number;
    goals: RoadmapGoal[];
    items: RoadmapPlanItem[];
    repositoryFullName: string;
    repositoryId: number;
  }) {
    const current = this.records.get(input.repositoryId);
    if ((current?.revision ?? 0) !== input.expectedRevision) {
      throw new RoadmapRevisionConflict(structuredClone(current ?? emptyStoredRoadmap(
        input.repositoryId,
        input.repositoryFullName
      )));
    }
    const next: StoredRoadmapPlan = {
      ...(current ?? emptyStoredRoadmap(input.repositoryId, input.repositoryFullName)),
      goals: structuredClone(input.goals),
      items: structuredClone(input.items),
      repositoryFullName: input.repositoryFullName,
      revision: input.expectedRevision + 1,
      updatedAt: new Date().toISOString()
    };
    this.records.set(input.repositoryId, next);
    return structuredClone(next);
  }

  async saveDependencies(
    repositoryId: number,
    repositoryFullName: string,
    principalId: string,
    dependencies: RoadmapDependency[],
    checkedAt: string
  ) {
    const current = this.records.get(repositoryId) ?? emptyStoredRoadmap(
      repositoryId,
      repositoryFullName
    );
    this.records.set(repositoryId, { ...current, repositoryFullName });
    this.snapshots.set(`${repositoryId}:${principalId}`, {
      dependencies: structuredClone(dependencies),
      dependencyCheckedAt: checkedAt
    });
  }
}

export function emptyStoredRoadmap(
  repositoryId: number,
  repositoryFullName: string
): StoredRoadmapPlan {
  return {
    dependencies: [],
    goals: [],
    items: [],
    repositoryFullName,
    repositoryId,
    revision: 0
  };
}
