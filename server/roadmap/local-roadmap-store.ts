import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RoadmapDependency, RoadmapGoal, RoadmapPlanItem } from '../../src/shared/roadmap-api';
import {
  emptyStoredRoadmap,
  RoadmapRevisionConflict,
  type RoadmapPlanStore,
  type StoredRoadmapPlan
} from './roadmap-store';

interface LocalRoadmapFile {
  records: Record<string, StoredRoadmapPlan>;
  snapshots: Record<string, Pick<StoredRoadmapPlan, 'dependencies' | 'dependencyCheckedAt'>>;
  version: 1;
}

export class RoadmapStorageCorruption extends Error {
  constructor(path: string) {
    super(`Roadmap storage at ${path} is not valid JSON. Restore or remove it before saving.`);
    this.name = 'RoadmapStorageCorruption';
  }
}

export class LocalRoadmapPlanStore implements RoadmapPlanStore {
  constructor(private readonly path: string) {}

  async read(repositoryId: number, principalId: string) {
    const file = this.readFile();
    const record = file.records[String(repositoryId)];
    if (!record) return undefined;
    const snapshot = file.snapshots[`${repositoryId}:${principalId}`];
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
    const file = this.readFile();
    const key = String(input.repositoryId);
    const current = file.records[key];
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
    file.records[key] = next;
    this.writeFile(file);
    return structuredClone(next);
  }

  async saveDependencies(
    repositoryId: number,
    repositoryFullName: string,
    principalId: string,
    dependencies: RoadmapDependency[],
    checkedAt: string
  ) {
    const file = this.readFile();
    const key = String(repositoryId);
    const current = file.records[key] ?? emptyStoredRoadmap(repositoryId, repositoryFullName);
    file.records[key] = { ...current, repositoryFullName };
    file.snapshots[`${repositoryId}:${principalId}`] = {
      dependencies: structuredClone(dependencies),
      dependencyCheckedAt: checkedAt
    };
    this.writeFile(file);
  }

  private readFile(): LocalRoadmapFile {
    if (!existsSync(this.path)) return { records: {}, snapshots: {}, version: 1 };
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<LocalRoadmapFile>;
      if (parsed.version === 1
        && parsed.records
        && typeof parsed.records === 'object'
        && parsed.snapshots
        && typeof parsed.snapshots === 'object') {
        return { records: parsed.records, snapshots: parsed.snapshots, version: 1 };
      }
      throw new RoadmapStorageCorruption(this.path);
    } catch {
      throw new RoadmapStorageCorruption(this.path);
    }
  }

  private writeFile(file: LocalRoadmapFile) {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(file, null, 2), { mode: 0o600 });
    renameSync(temporaryPath, this.path);
  }
}
