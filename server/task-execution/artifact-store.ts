import { createHash } from 'node:crypto';

import type { DatabaseQueryClient } from '../database/client';

export interface StoredTaskHandoffArtifactBlob {
  content: Uint8Array;
  createdAt: string;
  digest: `sha256:${string}`;
  mediaType: string;
  ownerUserId: string;
  provenanceReference: string;
  reference: string;
  sizeBytes: number;
}

export type TaskHandoffArtifactBlobWriteResult =
  | { kind: 'conflict' }
  | { blob: StoredTaskHandoffArtifactBlob; kind: 'created' | 'replayed' };

export interface TaskHandoffArtifactBlobStore {
  put(input: StoredTaskHandoffArtifactBlob): Promise<TaskHandoffArtifactBlobWriteResult>;
  read(ownerUserId: string, reference: string): Promise<StoredTaskHandoffArtifactBlob | undefined>;
}

interface BlobRow {
  content: Buffer | Uint8Array;
  created_at: Date | string;
  digest_sha256: string;
  id: string;
  media_type: string;
  owner_user_id: string;
  provenance_reference: string;
  size_bytes: number | string;
}

const columns = `
  id, owner_user_id, digest_sha256, media_type, size_bytes, content,
  provenance_reference, created_at
`;

export class PostgresTaskHandoffArtifactBlobStore implements TaskHandoffArtifactBlobStore {
  constructor(private readonly client: DatabaseQueryClient) {}

  async put(input: StoredTaskHandoffArtifactBlob): Promise<TaskHandoffArtifactBlobWriteResult> {
    assertBlob(input);
    const inserted = await this.client.query<BlobRow>(
      `insert into task_handoff_artifact_blobs (
         id, owner_user_id, digest_sha256, media_type, size_bytes, content,
         provenance_reference, created_at
       ) values ($1::uuid, $2, $3, $4, $5, $6, $7, $8::timestamptz)
       on conflict (id, owner_user_id) do nothing
       returning ${columns}`,
      [
        input.reference, input.ownerUserId, input.digest.slice(7), input.mediaType,
        input.sizeBytes, Buffer.from(input.content), input.provenanceReference, input.createdAt
      ]
    );
    if (inserted.rows[0]) return { blob: mapBlob(inserted.rows[0]), kind: 'created' };
    const existing = await this.read(input.ownerUserId, input.reference);
    return existing && sameBlob(existing, input)
      ? { blob: existing, kind: 'replayed' }
      : { kind: 'conflict' };
  }

  async read(ownerUserId: string, reference: string) {
    const result = await this.client.query<BlobRow>(
      `select ${columns} from task_handoff_artifact_blobs
        where owner_user_id = $1 and id = $2::uuid`,
      [ownerUserId, reference]
    );
    return result.rows[0] ? mapBlob(result.rows[0]) : undefined;
  }
}

export class MemoryTaskHandoffArtifactBlobStore implements TaskHandoffArtifactBlobStore {
  private readonly blobs = new Map<string, StoredTaskHandoffArtifactBlob>();

  async put(input: StoredTaskHandoffArtifactBlob): Promise<TaskHandoffArtifactBlobWriteResult> {
    assertBlob(input);
    const id = key(input.ownerUserId, input.reference);
    const existing = this.blobs.get(id);
    if (existing) {
      return sameBlob(existing, input)
        ? { blob: cloneBlob(existing), kind: 'replayed' }
        : { kind: 'conflict' };
    }
    const stored = cloneBlob(input);
    this.blobs.set(id, stored);
    return { blob: cloneBlob(stored), kind: 'created' };
  }

  async read(ownerUserId: string, reference: string) {
    const value = this.blobs.get(key(ownerUserId, reference));
    return value ? cloneBlob(value) : undefined;
  }
}

function mapBlob(row: BlobRow): StoredTaskHandoffArtifactBlob {
  const blob: StoredTaskHandoffArtifactBlob = {
    content: new Uint8Array(row.content),
    createdAt: new Date(row.created_at).toISOString(),
    digest: `sha256:${row.digest_sha256}`,
    mediaType: row.media_type,
    ownerUserId: row.owner_user_id,
    provenanceReference: row.provenance_reference,
    reference: row.id,
    sizeBytes: Number(row.size_bytes)
  };
  assertBlob(blob);
  return blob;
}

function assertBlob(input: StoredTaskHandoffArtifactBlob) {
  const bytes = Buffer.from(input.content);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (!uuidPattern.test(input.reference) || !input.ownerUserId.trim() ||
      !mediaTypePattern.test(input.mediaType) || input.mediaType.length > 128 ||
      !referencePattern.test(input.provenanceReference) ||
      !/^sha256:[0-9a-f]{64}$/.test(input.digest) ||
      input.digest !== `sha256:${digest}` || !Number.isSafeInteger(input.sizeBytes) ||
      input.sizeBytes !== bytes.byteLength || input.sizeBytes > maximumArtifactBytes ||
      !Number.isFinite(Date.parse(input.createdAt))) {
    throw new Error('Task Handoff artifact blob is invalid.');
  }
}

function sameBlob(left: StoredTaskHandoffArtifactBlob, right: StoredTaskHandoffArtifactBlob) {
  return left.digest === right.digest && left.mediaType === right.mediaType &&
    left.sizeBytes === right.sizeBytes && left.provenanceReference === right.provenanceReference &&
    Buffer.from(left.content).equals(Buffer.from(right.content));
}

function cloneBlob(input: StoredTaskHandoffArtifactBlob): StoredTaskHandoffArtifactBlob {
  return { ...structuredClone(input), content: new Uint8Array(input.content) };
}

function key(ownerUserId: string, reference: string) {
  return `${ownerUserId}\0${reference}`;
}

export const maximumTaskHandoffArtifactBytes = 8 * 1024 * 1024;
const maximumArtifactBytes = maximumTaskHandoffArtifactBytes;
const mediaTypePattern = /^[A-Za-z0-9][A-Za-z0-9.+-]*\/[A-Za-z0-9][A-Za-z0-9.+-]*$/;
const referencePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
