import type { TaskHandoffArtifactRef } from '../../src/shared/task-execution-api';
import type { DatabaseQueryClient } from '../database/client';
import type {
  StoredTaskHandoffRevision,
  TaskHandoffStore,
  TaskHandoffWriteResult
} from './contracts';

interface RevisionRow {
  acceptance_criteria: unknown;
  constraints: unknown;
  context: string;
  created_at: Date | string;
  created_by_id: string;
  created_by_kind: StoredTaskHandoffRevision['createdBy']['kind'];
  decisions: unknown;
  fingerprint_sha256: string;
  handoff_id: string;
  objective: string;
  owner_user_id: string;
  requested_mode: StoredTaskHandoffRevision['requestedMode'];
  requested_permissions: unknown;
  revision: number;
  task_id: string;
}

interface ArtifactRow {
  artifact_kind: TaskHandoffArtifactRef['kind'];
  artifact_id: string;
  artifact_name: string;
  authorization_kind: TaskHandoffArtifactRef['authorization']['kind'];
  authorization_reference: string | null;
  digest_sha256: string;
  media_type: string;
  provenance_kind: TaskHandoffArtifactRef['provenance']['kind'];
  provenance_reference: string | null;
  size_bytes: number | string;
  storage_kind: TaskHandoffArtifactRef['storage']['kind'];
  storage_reference: string;
  verification_state: TaskHandoffArtifactRef['verification']['state'];
  verified_at: Date | string | null;
}

export class PostgresTaskHandoffStore implements TaskHandoffStore {
  constructor(private readonly client: DatabaseQueryClient) {}

  create(input: StoredTaskHandoffRevision) {
    assertRevision(input);
    if (input.revision !== 1) return Promise.resolve({ kind: 'conflict' } as const);
    return this.write(input, true);
  }

  appendRevision(input: StoredTaskHandoffRevision) {
    assertRevision(input);
    if (input.revision <= 1) return Promise.resolve({ kind: 'conflict' } as const);
    return this.write(input, false);
  }

  async read(ownerUserId: string, handoffId: string, revision?: number) {
    const result = await this.client.query<RevisionRow>(
      `select handoff_id, owner_user_id, revision, task_id, fingerprint_sha256,
              objective, context, decisions, acceptance_criteria, constraints,
              requested_mode, requested_permissions, created_by_kind, created_by_id, created_at
         from task_handoff_revisions
        where owner_user_id = $1 and handoff_id = $2::uuid
          and ($3::integer is null or revision = $3)
        order by revision desc
        limit 1`,
      [ownerUserId, handoffId, revision ?? null]
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return mapRevision(row, await this.readArtifacts(ownerUserId, handoffId, row.revision));
  }

  async archive(ownerUserId: string, handoffId: string, archivedAt: string) {
    const result = await this.client.query<{ id: string }>(
      `update task_handoffs
          set archived_at = coalesce(archived_at, $3::timestamptz)
        where owner_user_id = $1 and id = $2::uuid
        returning id`,
      [ownerUserId, handoffId, archivedAt]
    );
    return result.rows.length === 1;
  }

  private async write(
    input: StoredTaskHandoffRevision,
    create: boolean
  ): Promise<TaskHandoffWriteResult> {
    const run = async (client: DatabaseQueryClient): Promise<TaskHandoffWriteResult> => {
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [
        `task-handoff:${input.ownerUserId}:${input.handoffId}`
      ]);
      const existing = await readExact(client, input.ownerUserId, input.handoffId, input.revision);
      if (existing) {
        const revision = mapRevision(existing, await readArtifactsWith(
          client, input.ownerUserId, input.handoffId, input.revision
        ));
        return existing.fingerprint_sha256 === input.fingerprint &&
          existing.task_id === input.taskId
          ? { kind: 'replayed', revision }
          : { kind: 'conflict' };
      }
      if (create) {
        await client.query(
          `insert into task_handoffs (id, owner_user_id, task_id, created_at)
           values ($1::uuid, $2, $3, $4::timestamptz)`,
          [input.handoffId, input.ownerUserId, input.taskId, input.createdAt]
        );
      } else {
        const parent = await client.query<{ latest: number; task_id: string }>(
          `select h.task_id, max(r.revision)::integer as latest
             from task_handoffs h
             join task_handoff_revisions r
               on r.handoff_id = h.id and r.owner_user_id = h.owner_user_id
            where h.owner_user_id = $1 and h.id = $2::uuid and h.archived_at is null
            group by h.task_id`,
          [input.ownerUserId, input.handoffId]
        );
        if (!parent.rows[0] || parent.rows[0].task_id !== input.taskId ||
            parent.rows[0].latest + 1 !== input.revision) return { kind: 'conflict' };
      }
      await insertRevision(client, input);
      return { kind: 'created', revision: structuredClone(input) };
    };
    return this.client.transaction ? this.client.transaction(run) : run(this.client);
  }

  private readArtifacts(ownerUserId: string, handoffId: string, revision: number) {
    return readArtifactsWith(this.client, ownerUserId, handoffId, revision);
  }
}

export class MemoryTaskHandoffStore implements TaskHandoffStore {
  private readonly revisions = new Map<string, StoredTaskHandoffRevision[]>();
  private readonly archived = new Set<string>();

  async create(input: StoredTaskHandoffRevision): Promise<TaskHandoffWriteResult> {
    assertRevision(input);
    if (input.revision !== 1) return { kind: 'conflict' };
    return this.write(input, true);
  }

  async appendRevision(input: StoredTaskHandoffRevision): Promise<TaskHandoffWriteResult> {
    assertRevision(input);
    if (input.revision <= 1) return { kind: 'conflict' };
    return this.write(input, false);
  }

  async read(ownerUserId: string, handoffId: string, revision?: number) {
    const values = this.revisions.get(key(ownerUserId, handoffId)) ?? [];
    const value = revision === undefined
      ? values.at(-1)
      : values.find((candidate) => candidate.revision === revision);
    return value ? structuredClone(value) : undefined;
  }

  async archive(ownerUserId: string, handoffId: string) {
    const id = key(ownerUserId, handoffId);
    if (!this.revisions.has(id)) return false;
    this.archived.add(id);
    return true;
  }

  private write(input: StoredTaskHandoffRevision, create: boolean): TaskHandoffWriteResult {
    const id = key(input.ownerUserId, input.handoffId);
    const values = this.revisions.get(id) ?? [];
    const existing = values.find(({ revision }) => revision === input.revision);
    if (existing) {
      return existing.fingerprint === input.fingerprint && existing.taskId === input.taskId
        ? { kind: 'replayed', revision: structuredClone(existing) }
        : { kind: 'conflict' };
    }
    if (this.archived.has(id) || create !== (values.length === 0) ||
        input.revision !== values.length + 1 ||
        (values[0] && values[0].taskId !== input.taskId)) return { kind: 'conflict' };
    values.push(structuredClone(input));
    this.revisions.set(id, values);
    return { kind: 'created', revision: structuredClone(input) };
  }
}

async function insertRevision(client: DatabaseQueryClient, input: StoredTaskHandoffRevision) {
  await client.query(
    `insert into task_handoff_revisions (
       handoff_id, owner_user_id, revision, task_id, fingerprint_sha256,
       objective, context, decisions, acceptance_criteria, constraints,
       requested_mode, requested_permissions, created_by_kind, created_by_id, created_at
     ) values (
       $1::uuid, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb,
       $11, $12::jsonb, $13, $14, $15::timestamptz
     )`,
    [
      input.handoffId, input.ownerUserId, input.revision, input.taskId, input.fingerprint,
      input.objective, input.context, JSON.stringify(input.decisions),
      JSON.stringify(input.acceptanceCriteria), JSON.stringify(input.constraints),
      input.requestedMode, JSON.stringify(input.requestedPermissions),
      input.createdBy.kind, input.createdBy.id, input.createdAt
    ]
  );
  for (const artifact of input.artifacts) {
    await client.query(
      `insert into task_handoff_artifacts (
         handoff_id, owner_user_id, revision, artifact_id, media_type, digest_sha256,
         size_bytes, storage_kind, storage_reference, authorization_kind,
         authorization_reference, provenance_kind, provenance_reference, artifact_kind,
         artifact_name, verification_state, verified_at
       ) values (
         $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
         $14, $15, $16, $17::timestamptz
       )`,
      [
        input.handoffId, input.ownerUserId, input.revision, artifact.id,
        artifact.mediaType, artifact.digest.slice(7), artifact.sizeBytes,
        artifact.storage.kind, artifact.storage.reference, artifact.authorization.kind,
        artifact.authorization.reference ?? null, artifact.provenance.kind,
        artifact.provenance.reference ?? null, artifact.kind, artifact.name,
        artifact.verification.state, artifact.verification.verifiedAt ?? null
      ]
    );
  }
}

async function readExact(
  client: DatabaseQueryClient,
  ownerUserId: string,
  handoffId: string,
  revision: number
) {
  const result = await client.query<RevisionRow>(
    `select handoff_id, owner_user_id, revision, task_id, fingerprint_sha256,
            objective, context, decisions, acceptance_criteria, constraints,
            requested_mode, requested_permissions, created_by_kind, created_by_id, created_at
       from task_handoff_revisions
      where owner_user_id = $1 and handoff_id = $2::uuid and revision = $3
      for update`,
    [ownerUserId, handoffId, revision]
  );
  return result.rows[0];
}

async function readArtifactsWith(
  client: DatabaseQueryClient,
  ownerUserId: string,
  handoffId: string,
  revision: number
) {
  const result = await client.query<ArtifactRow>(
    `select artifact_id, artifact_kind, artifact_name, media_type, digest_sha256,
            size_bytes, storage_kind,
            storage_reference, authorization_kind, authorization_reference,
            provenance_kind, provenance_reference, verification_state, verified_at
       from task_handoff_artifacts
      where owner_user_id = $1 and handoff_id = $2::uuid and revision = $3
      order by artifact_id`,
    [ownerUserId, handoffId, revision]
  );
  return result.rows.map(mapArtifact);
}

function mapRevision(row: RevisionRow, artifacts: TaskHandoffArtifactRef[]): StoredTaskHandoffRevision {
  return {
    acceptanceCriteria: stringArray(row.acceptance_criteria),
    artifacts,
    constraints: stringArray(row.constraints),
    context: row.context,
    createdAt: new Date(row.created_at).toISOString(),
    createdBy: { id: row.created_by_id, kind: row.created_by_kind },
    decisions: stringArray(row.decisions),
    fingerprint: row.fingerprint_sha256,
    handoffId: row.handoff_id,
    objective: row.objective,
    ownerUserId: row.owner_user_id,
    requestedMode: row.requested_mode,
    requestedPermissions: requestedPermissions(row.requested_permissions),
    revision: Number(row.revision),
    taskId: row.task_id
  };
}

function mapArtifact(row: ArtifactRow): TaskHandoffArtifactRef {
  return {
    authorization: {
      kind: row.authorization_kind,
      ...(row.authorization_reference ? { reference: row.authorization_reference } : {})
    },
    digest: `sha256:${row.digest_sha256}`,
    id: row.artifact_id,
    kind: row.artifact_kind,
    mediaType: row.media_type,
    name: row.artifact_name,
    provenance: {
      kind: row.provenance_kind,
      ...(row.provenance_reference ? { reference: row.provenance_reference } : {})
    },
    sizeBytes: Number(row.size_bytes),
    storage: { kind: row.storage_kind, reference: row.storage_reference },
    verification: {
      state: row.verification_state,
      ...(row.verified_at ? { verifiedAt: new Date(row.verified_at).toISOString() } : {})
    }
  };
}

function assertRevision(input: StoredTaskHandoffRevision) {
  const referencePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/;
  const listInvalid = (entries: string[]) => entries.length > 100 ||
    entries.some((entry) => typeof entry !== 'string' || entry.length > 4000);
  if (!uuidPattern.test(input.handoffId) || !input.ownerUserId.trim() ||
      !input.taskId.trim() || input.taskId.length > 512 ||
      !Number.isSafeInteger(input.revision) || input.revision <= 0 ||
      !Number.isFinite(Date.parse(input.createdAt)) ||
      !input.createdBy.id.trim() || !/^[0-9a-f]{64}$/.test(input.fingerprint) ||
      input.artifacts.length > 32 || new Set(input.artifacts.map(({ id }) => id)).size !==
      input.artifacts.length ||
      !input.objective.trim() || input.objective.length > 12_000 ||
      input.context.length > 60_000 || input.createdBy.id.length > 256 ||
      !isRequestedPermissions(input.requestedPermissions) ||
      listInvalid(input.decisions) || listInvalid(input.acceptanceCriteria) ||
      listInvalid(input.constraints) ||
      input.artifacts.some((artifact) => !/^sha256:[0-9a-f]{64}$/.test(artifact.digest) ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(artifact.id) ||
        !artifact.name.trim() || artifact.name.length > 512 ||
        !/^[A-Za-z0-9][A-Za-z0-9.+-]*\/[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(
          artifact.mediaType
        ) || artifact.mediaType.length > 128 ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(artifact.storage.reference) ||
        (artifact.authorization.kind === 'owner'
          ? artifact.authorization.reference !== undefined
          : artifact.authorization.kind === 'task'
            ? artifact.authorization.reference !== input.taskId
            : !artifact.authorization.reference ||
              !uuidPattern.test(artifact.authorization.reference)) ||
        (artifact.provenance.reference !== undefined &&
          !referencePattern.test(artifact.provenance.reference)) ||
        (artifact.provenance.kind !== 'user_upload' && !artifact.provenance.reference) ||
        (artifact.verification.state === 'verified') !==
          (artifact.verification.verifiedAt !== undefined) ||
        (artifact.verification.verifiedAt !== undefined &&
          !Number.isFinite(Date.parse(artifact.verification.verifiedAt))) ||
        !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 0 ||
        artifact.sizeBytes > 104_857_600)) {
    throw new Error('Task Handoff revision is invalid.');
  }
}

function requestedPermissions(value: unknown): StoredTaskHandoffRevision['requestedPermissions'] {
  if (!isRequestedPermissions(value)) throw new Error('Task Handoff revision is invalid.');
  return value;
}

function isRequestedPermissions(
  value: unknown
): value is StoredTaskHandoffRevision['requestedPermissions'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const permissions = value as Record<string, unknown>;
  return Object.keys(permissions).length === 5 &&
    ['none', 'pull_request'].includes(String(permissions.delivery)) &&
    ['none', 'restricted', 'open'].includes(String(permissions.network)) &&
    ['read', 'write'].includes(String(permissions.repository)) &&
    ['read', 'write'].includes(String(permissions.task)) &&
    ['read', 'write'].includes(String(permissions.workspace));
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function stringArray(value: unknown) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error('Task Handoff revision is invalid.');
  }
  return value as string[];
}

function key(ownerUserId: string, handoffId: string) {
  return `${ownerUserId}\0${handoffId}`;
}
