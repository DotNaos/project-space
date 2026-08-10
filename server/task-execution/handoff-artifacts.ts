import { createHash } from 'node:crypto';

import type {
  ExistingTaskHandoffArtifactInput,
  InlineTaskHandoffArtifactInput,
  TaskHandoffArtifactInput,
  TaskHandoffArtifactProjection
} from '../../src/shared/task-handoff-mcp-api';
import type { TaskHandoffArtifactRef } from '../../src/shared/task-execution-api';
import type {
  StoredTaskHandoffRevision,
  TaskHandoffStore
} from './contracts';
import {
  maximumTaskHandoffArtifactBytes,
  type StoredTaskHandoffArtifactBlob,
  type TaskHandoffArtifactBlobStore
} from './artifact-store';
import { deterministicTaskExecutionId } from './service-identity';

export interface PreparedTaskHandoffArtifact {
  blob: StoredTaskHandoffArtifactBlob;
  reference: TaskHandoffArtifactRef;
}

export async function prepareTaskHandoffArtifacts(input: {
  actor: { clientId?: string; userId: string };
  artifacts: TaskHandoffArtifactInput[];
  blobs: TaskHandoffArtifactBlobStore;
  handoffId: string;
  handoffs: TaskHandoffStore;
  revision: number;
  taskId: string;
  verifiedAt: string;
}): Promise<PreparedTaskHandoffArtifact[]> {
  const ids = new Set<string>();
  const prepared: PreparedTaskHandoffArtifact[] = [];
  let totalBytes = 0;
  for (const artifact of input.artifacts) {
    if (ids.has(artifact.id)) throw new Error('Task Handoff artifact IDs must be unique.');
    ids.add(artifact.id);
    const value = isInlineArtifact(artifact)
      ? prepareInline(input, artifact)
      : await prepareExisting(input, artifact);
    totalBytes += value.blob.sizeBytes;
    if (totalBytes > maximumTaskHandoffTotalArtifactBytes) {
      throw new Error('Task Handoff artifacts exceed the total size limit.');
    }
    prepared.push(value);
  }
  return prepared;
}

export async function persistTaskHandoffArtifacts(
  blobs: TaskHandoffArtifactBlobStore,
  artifacts: PreparedTaskHandoffArtifact[]
) {
  for (const artifact of artifacts) {
    const result = await blobs.put(artifact.blob);
    if (result.kind === 'conflict') {
      throw new Error('Task Handoff artifact identity conflicts.');
    }
  }
}

export async function projectTaskHandoffArtifacts(
  ownerUserId: string,
  artifacts: TaskHandoffArtifactRef[],
  blobs: TaskHandoffArtifactBlobStore
): Promise<TaskHandoffArtifactProjection[]> {
  return Promise.all(artifacts.map(async (artifact) => {
    if (artifact.storage.kind !== 'project_space_blob' ||
        artifact.verification.state !== 'verified') {
      throw new TaskHandoffArtifactUnavailableError();
    }
    const blob = await blobs.read(ownerUserId, artifact.storage.reference);
    if (!blob || blob.digest !== artifact.digest || blob.mediaType !== artifact.mediaType ||
        blob.sizeBytes !== artifact.sizeBytes) {
      throw new TaskHandoffArtifactUnavailableError();
    }
    return {
      ...structuredClone(artifact),
      content: projectContent(blob.content, blob.mediaType)
    };
  }));
}

export class TaskHandoffArtifactUnavailableError extends Error {
  constructor() {
    super('A Task Handoff artifact is unavailable or failed verification.');
    this.name = 'TaskHandoffArtifactUnavailableError';
  }
}

function prepareInline(
  input: Parameters<typeof prepareTaskHandoffArtifacts>[0],
  artifact: InlineTaskHandoffArtifactInput
): PreparedTaskHandoffArtifact {
  const content = decodeContent(artifact.source.encoding, artifact.source.data);
  const digest = `sha256:${createHash('sha256').update(content).digest('hex')}` as const;
  if (content.byteLength !== artifact.sizeBytes || digest !== artifact.digest ||
      content.byteLength > maximumTaskHandoffArtifactBytes) {
    throw new Error('Task Handoff artifact size or digest does not match its content.');
  }
  const provenanceReference = provenanceFor(input.actor);
  const reference = deterministicTaskExecutionId(
    'task-handoff-artifact', input.actor.userId, input.handoffId,
    String(input.revision), artifact.id, digest
  );
  return {
    blob: {
      content,
      createdAt: input.verifiedAt,
      digest,
      mediaType: artifact.mediaType,
      ownerUserId: input.actor.userId,
      provenanceReference,
      reference,
      sizeBytes: content.byteLength
    },
    reference: {
      authorization: { kind: 'task', reference: input.taskId },
      digest,
      id: artifact.id,
      kind: artifact.kind,
      mediaType: artifact.mediaType,
      name: artifact.name,
      provenance: { kind: 'orchestrator', reference: provenanceReference },
      sizeBytes: content.byteLength,
      storage: { kind: 'project_space_blob', reference },
      verification: { state: 'verified', verifiedAt: input.verifiedAt }
    }
  };
}

async function prepareExisting(
  input: Parameters<typeof prepareTaskHandoffArtifacts>[0],
  artifact: ExistingTaskHandoffArtifactInput
): Promise<PreparedTaskHandoffArtifact> {
  const source = await input.handoffs.read(
    input.actor.userId,
    artifact.source.handoffId,
    artifact.source.revision
  );
  if (!source || source.taskId !== input.taskId) throw new TaskHandoffArtifactUnavailableError();
  const existing = source.artifacts.find(({ id }) => id === artifact.source.artifactId);
  if (!existing || existing.storage.kind !== 'project_space_blob' ||
      existing.verification.state !== 'verified') {
    throw new TaskHandoffArtifactUnavailableError();
  }
  const blob = await input.blobs.read(input.actor.userId, existing.storage.reference);
  if (!blob || blob.digest !== existing.digest || blob.mediaType !== existing.mediaType ||
      blob.sizeBytes !== existing.sizeBytes) throw new TaskHandoffArtifactUnavailableError();
  return {
    blob,
    reference: {
      ...structuredClone(existing),
      authorization: { kind: 'task', reference: input.taskId },
      id: artifact.id
    }
  };
}

function decodeContent(encoding: 'base64' | 'utf8', data: string) {
  if (encoding === 'utf8') return new Uint8Array(Buffer.from(data, 'utf8'));
  if (!canonicalBase64Pattern.test(data)) throw new Error('Task Handoff artifact base64 is invalid.');
  const content = Buffer.from(data, 'base64');
  if (content.toString('base64') !== data) throw new Error('Task Handoff artifact base64 is invalid.');
  return new Uint8Array(content);
}

function projectContent(content: Uint8Array, mediaType: string) {
  if (isTextMediaType(mediaType)) {
    try {
      return {
        data: new TextDecoder('utf-8', { fatal: true }).decode(content),
        encoding: 'utf8' as const
      };
    } catch {
      // Invalid UTF-8 is still safely available as base64.
    }
  }
  return { data: Buffer.from(content).toString('base64'), encoding: 'base64' as const };
}

function isTextMediaType(mediaType: string) {
  return mediaType.startsWith('text/') || [
    'application/json', 'application/ld+json', 'application/xml',
    'application/yaml', 'image/svg+xml'
  ].includes(mediaType);
}

function provenanceFor(actor: { clientId?: string; userId: string }) {
  const source = actor.clientId ?? `user:${actor.userId}`;
  return `mcp:${createHash('sha256').update(source).digest('hex').slice(0, 48)}`;
}

function isInlineArtifact(
  artifact: TaskHandoffArtifactInput
): artifact is InlineTaskHandoffArtifactInput {
  return artifact.source.kind === 'inline';
}

const maximumTaskHandoffTotalArtifactBytes = 16 * 1024 * 1024;
const canonicalBase64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
