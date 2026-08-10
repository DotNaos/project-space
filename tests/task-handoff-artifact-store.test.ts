import { createHash } from 'node:crypto';

import { describe, expect, it } from 'bun:test';

import type { DatabaseQueryClient, DatabaseQueryResult } from '../server/database/client';
import {
  taskHandoffArtifactMigrationId,
  taskHandoffArtifactMigrationSql
} from '../server/database/task-handoff-artifact-migration';
import { databaseMigrations } from '../server/database/migrations';
import {
  MemoryTaskHandoffArtifactBlobStore,
  PostgresTaskHandoffArtifactBlobStore,
  type StoredTaskHandoffArtifactBlob
} from '../server/task-execution/artifact-store';

const content = Buffer.from('verified cross-orchestrator design', 'utf8');
const digest = `sha256:${createHash('sha256').update(content).digest('hex')}` as const;
const reference = '10000000-0000-4000-8000-000000000001';
const owner = 'owner-a';
const createdAt = '2026-08-09T13:00:00.000Z';
const blob: StoredTaskHandoffArtifactBlob = {
  content,
  createdAt,
  digest,
  mediaType: 'text/markdown',
  ownerUserId: owner,
  provenanceReference: 'mcp:verified-client',
  reference,
  sizeBytes: content.byteLength
};

describe('Task Handoff artifact blob storage', () => {
  it('keeps bytes owner scoped and replays only an exact verified blob', async () => {
    const store = new MemoryTaskHandoffArtifactBlobStore();
    expect((await store.put(blob)).kind).toBe('created');
    expect((await store.put(structuredClone(blob))).kind).toBe('replayed');
    expect((await store.put({
      ...blob,
      provenanceReference: 'mcp:different-client'
    })).kind).toBe('conflict');
    expect(await store.read('owner-b', reference)).toBeUndefined();
    expect(Buffer.from((await store.read(owner, reference))!.content).toString('utf8'))
      .toBe(content.toString('utf8'));
  });

  it('recomputes digest and size before accepting content', async () => {
    const store = new MemoryTaskHandoffArtifactBlobStore();
    await expect(store.put({
      ...blob,
      digest: `sha256:${'0'.repeat(64)}`
    })).rejects.toThrow('invalid');
    await expect(store.put({ ...blob, sizeBytes: content.byteLength + 1 }))
      .rejects.toThrow('invalid');
  });

  it('uses owner plus opaque UUID identity in Postgres and maps bytes defensively', async () => {
    const database = new FakeDatabase();
    database.responses.push({ rows: [row()] });
    const store = new PostgresTaskHandoffArtifactBlobStore(database);
    expect(await store.put(blob)).toMatchObject({
      blob: { digest, ownerUserId: owner, reference },
      kind: 'created'
    });
    expect(database.calls[0]?.sql).toContain('on conflict (id, owner_user_id) do nothing');
    expect(database.calls[0]?.values.slice(0, 5)).toEqual([
      reference, owner, digest.slice(7), 'text/markdown', content.byteLength
    ]);

    database.responses.push({ rows: [row()] });
    expect(await store.read(owner, reference)).toMatchObject({ digest, sizeBytes: content.byteLength });
    expect(database.calls.at(-1)?.values).toEqual([owner, reference]);
  });

  it('registers an append-only blob migration without URLs, paths, or credentials', () => {
    expect(databaseMigrations.find(({ id }) => id === taskHandoffArtifactMigrationId))
      .toEqual({ id: taskHandoffArtifactMigrationId, sql: taskHandoffArtifactMigrationSql });
    expect(taskHandoffArtifactMigrationSql).toContain('create table task_handoff_artifact_blobs');
    expect(taskHandoffArtifactMigrationSql).toContain('octet_length(content) = size_bytes');
    expect(taskHandoffArtifactMigrationSql).toContain('requested_permissions');
    expect(taskHandoffArtifactMigrationSql).toContain("verification_state = 'verified'");
    expect(taskHandoffArtifactMigrationSql).not.toMatch(
      /\b(access_token|refresh_token|device_code|login_id|raw_path|source_url)\b/
    );
  });
});

class FakeDatabase implements DatabaseQueryClient {
  readonly calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  readonly responses: Array<DatabaseQueryResult<unknown>> = [];

  async query<Row>(sql: string, values: readonly unknown[] = []) {
    this.calls.push({ sql, values });
    return (this.responses.shift() ?? { rows: [] }) as DatabaseQueryResult<Row>;
  }
}

function row() {
  return {
    content,
    created_at: createdAt,
    digest_sha256: digest.slice(7),
    id: reference,
    media_type: 'text/markdown',
    owner_user_id: owner,
    provenance_reference: 'mcp:verified-client',
    size_bytes: content.byteLength
  };
}
