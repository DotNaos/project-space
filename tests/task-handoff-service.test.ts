import { createHash } from 'node:crypto';

import { describe, expect, it } from 'bun:test';

import { MemoryTaskHandoffArtifactBlobStore } from '../server/task-execution/artifact-store';
import { MemoryTaskExecutionStore } from '../server/task-execution/execution-store';
import { createTaskHandoffService } from '../server/task-execution/handoff-service';
import { MemoryTaskHandoffStore } from '../server/task-execution/handoff-store';
import { MemoryTaskExecutionOperationStore } from '../server/task-execution/operation-store';
import type { TaskExecutionServiceDependencies } from '../server/task-execution/service';
import type { StoredTaskExecution } from '../server/task-execution/contracts';

const owner = { clientId: 'claude-orchestrator', userId: 'owner-a' };
const otherOwner = { clientId: 'codex-orchestrator', userId: 'owner-b' };
const taskId = 'github:DotNaos/project-space:554';
const handoffText = '# Design\n\nUse the provider-neutral Handoff.';
const handoffBytes = Buffer.from(handoffText, 'utf8');
const handoffDigest = `sha256:${createHash('sha256').update(handoffBytes).digest('hex')}` as const;
const environmentId = '10000000-0000-4000-8000-000000000001';
const executionId = '20000000-0000-4000-8000-000000000002';

describe('Task Handoff service', () => {
  it('verifies, stores, retrieves, and exactly replays a cross-machine design', async () => {
    const fixture = createFixture();
    const request = createRequest();
    const created = await fixture.service.create(owner, request);
    expect(created).toMatchObject({
      handoff: {
        artifacts: [{
          content: { data: handoffText, encoding: 'utf8' },
          digest: handoffDigest,
          kind: 'design',
          sizeBytes: handoffBytes.byteLength,
          storage: { kind: 'project_space_blob' },
          verification: { state: 'verified' }
        }],
        requestedMode: 'implement',
        requestedPermissions: {
          delivery: 'pull_request',
          repository: 'write',
          workspace: 'write'
        },
        revision: 1,
        taskId
      },
      operationId: request.operationId
    });

    const read = await fixture.service.get(owner, {
      handoffId: created.handoff.handoffId,
      revision: 1
    });
    expect(read.handoff.artifacts[0]?.content.data).toBe(handoffText);
    expect((await fixture.blobs.read(
      otherOwner.userId,
      created.handoff.artifacts[0]!.storage.reference
    ))).toBeUndefined();
    await expect(fixture.service.get(otherOwner, {
      handoffId: created.handoff.handoffId
    })).rejects.toThrow('not found');

    const replayed = await fixture.service.create(owner, request);
    expect(replayed).toMatchObject({
      handoff: { handoffId: created.handoff.handoffId, revision: 1 },
      replayed: true
    });
    await expect(fixture.service.create(owner, {
      ...request,
      objective: 'Changed objective'
    })).rejects.toThrow('operation ID');
  });

  it('appends only the expected revision and reuses a verified artifact by reference', async () => {
    const fixture = createFixture();
    const first = await fixture.service.create(owner, createRequest());
    const second = await fixture.service.create(owner, {
      ...createRequest(),
      artifacts: [{
        id: 'design-copy',
        source: {
          artifactId: 'design',
          handoffId: first.handoff.handoffId,
          kind: 'handoff',
          revision: 1
        }
      }],
      baseRevision: 1,
      handoffId: first.handoff.handoffId,
      objective: 'Implement the accepted design.',
      operationId: 'handoff-operation-002',
      requestedMode: 'review',
      requestedPermissions: readOnlyPermissions
    });
    expect(second).toMatchObject({
      handoff: {
        artifacts: [{
          content: { data: handoffText, encoding: 'utf8' },
          id: 'design-copy',
          storage: first.handoff.artifacts[0]!.storage
        }],
        requestedMode: 'review',
        requestedPermissions: readOnlyPermissions,
        revision: 2
      }
    });
    await expect(fixture.service.create(owner, {
      ...createRequest(),
      baseRevision: 1,
      handoffId: first.handoff.handoffId,
      operationId: 'handoff-operation-003'
    })).rejects.toThrow('base revision');
  });

  it('rejects mismatched bytes and never treats a client path as an artifact reference', async () => {
    const fixture = createFixture();
    await expect(fixture.service.create(owner, {
      ...createRequest(),
      artifacts: [{
        ...inlineArtifact(),
        digest: `sha256:${'0'.repeat(64)}`
      }]
    })).rejects.toThrow('digest');
  });

  it('updates a planned execution and then fails closed after an executor is bound', async () => {
    const fixture = createFixture();
    const first = await fixture.service.create(owner, createRequest());
    await fixture.executions.create(execution(first.handoff.handoffId));
    const second = await fixture.service.create(owner, {
      ...createRequest(),
      artifacts: [],
      baseRevision: 1,
      handoffId: first.handoff.handoffId,
      objective: 'Use the revised implementation plan.',
      operationId: 'handoff-operation-004'
    });

    const updated = await fixture.service.updateExecution(owner, {
      executionId,
      handoffId: first.handoff.handoffId,
      operationId: 'handoff-update-001',
      revision: second.handoff.revision
    });
    expect(updated).toMatchObject({
      execution: { handoff: { revision: 2 }, version: 2 },
      state: 'updated'
    });
    expect((await fixture.executions.listEvents(owner.userId, executionId)).at(-1))
      .toMatchObject({ type: 'handoff_updated' });

    expect(await fixture.executions.bindExecutor(owner.userId, {
      agent: 'codex',
      createdAt: new Date().toISOString(),
      executionId,
      externalId: 'thread:handoff-test',
      updatedAt: new Date().toISOString(),
      version: 1
    })).toBe('created');
    const third = await fixture.service.create(owner, {
      ...createRequest(),
      artifacts: [],
      baseRevision: 2,
      handoffId: first.handoff.handoffId,
      objective: 'A later revision must not silently steer Codex.',
      operationId: 'handoff-operation-005'
    });
    const blocked = await fixture.service.updateExecution(owner, {
      executionId,
      handoffId: first.handoff.handoffId,
      operationId: 'handoff-update-002',
      revision: third.handoff.revision
    });
    expect(blocked).toMatchObject({
      execution: { handoff: { revision: 2 } },
      state: 'blocked'
    });
  });
});

function createFixture() {
  const blobs = new MemoryTaskHandoffArtifactBlobStore();
  const executions = new MemoryTaskExecutionStore();
  const dependencies = {
    artifacts: blobs,
    handoffs: new MemoryTaskHandoffStore(),
    now: () => new Date('2026-08-09T13:00:00.000Z'),
    operations: new MemoryTaskExecutionOperationStore(() =>
      Date.parse('2026-08-09T13:00:00.000Z')
    ),
    source: {
      resolve: async () => ({
        branch: 'issue-554-agent-handoff',
        branchExists: true,
        provider: 'github' as const,
        providerTaskId: '554',
        repositoryId: '42',
        repositoryName: 'DotNaos/project-space',
        taskId,
        title: 'Verified agent handoffs'
      })
    },
    store: executions
  } as unknown as TaskExecutionServiceDependencies;
  return { blobs, executions, service: createTaskHandoffService(dependencies) };
}

function createRequest() {
  return {
    artifacts: [inlineArtifact()],
    objective: 'Implement the verified design.',
    operationId: 'handoff-operation-001',
    requestedMode: 'implement' as const,
    requestedPermissions: {
      delivery: 'pull_request' as const,
      network: 'restricted' as const,
      repository: 'write' as const,
      task: 'write' as const,
      workspace: 'write' as const
    },
    task: { number: 554, provider: 'github' as const, repositoryId: '42' }
  };
}

function inlineArtifact() {
  return {
    digest: handoffDigest,
    id: 'design',
    kind: 'design' as const,
    mediaType: 'text/markdown',
    name: 'Claude implementation design',
    sizeBytes: handoffBytes.byteLength,
    source: { data: handoffText, encoding: 'utf8' as const, kind: 'inline' as const }
  };
}

function execution(handoffId: string): StoredTaskExecution {
  const createdAt = '2026-08-09T13:00:00.000Z';
  return {
    agent: { kind: 'codex' },
    createdAt,
    environmentId,
    handoff: { id: handoffId, revision: 1 },
    id: executionId,
    ownerUserId: owner.userId,
    source: {
      branch: 'issue-554-agent-handoff',
      repositoryId: '42',
      taskId
    },
    state: 'planned',
    updatedAt: createdAt,
    version: 1
  };
}

const readOnlyPermissions = {
  delivery: 'none' as const,
  network: 'restricted' as const,
  repository: 'read' as const,
  task: 'read' as const,
  workspace: 'read' as const
};
