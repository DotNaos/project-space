import { describe, expect, test } from 'bun:test';

import { MemoryTaskExecutionOperationStore } from '../server/task-execution/operation-store';
import type { TaskExecutionService } from '../server/task-execution/service';
import type {
  TaskCompletionPolicy,
  TaskDeliveryEvidence,
  TaskDeliveryProvider,
  TaskDeliveryProviderObservation
} from '../server/task-delivery/contracts';
import { createTaskDeliveryService } from '../server/task-delivery/service';
import { taskDeliveryReviewRequestFingerprint } from '../server/task-delivery/review-fingerprint';
import { MemoryTaskDeliveryStore } from '../server/task-delivery/store';

const owner = 'owner-one';
const executionId = '11111111-1111-4111-8111-111111111111';
const successorExecutionId = '55555555-5555-4555-8555-555555555555';
const deliveryId = '22222222-2222-4222-8222-222222222222';
const reviewId = '33333333-3333-4333-8333-333333333333';
const now = '2026-08-09T12:00:00.000Z';
const head = 'a'.repeat(40);
const taskId = 'github:DotNaos/project-space:562';

class FailingEvidenceStore extends MemoryTaskDeliveryStore {
  private failAppend = false;

  failNextAppend() {
    this.failAppend = true;
  }

  override async appendEvidence(input: Omit<TaskDeliveryEvidence, 'revision'>) {
    if (this.failAppend) {
      this.failAppend = false;
      throw new Error('simulated evidence persistence failure');
    }
    return super.appendEvidence(input);
  }
}

function taskExecutions(): TaskExecutionService {
  return {
    async get(_actor, request) {
      return {
        apiVersion: 1, events: [], message: 'loaded',
        execution: {
          agent: 'codex', createdAt: now, environmentId: 'environment-one',
          handoff: { id: '44444444-4444-4444-8444-444444444444', revision: 1 },
          id: request.executionId,
          source: {
            branch: 'issue-562-delivery', commit: head, provider: 'github',
            providerTaskId: '562', repositoryId: '1001', taskId
          },
          state: 'verifying', updatedAt: now, version: 4
        }
      };
    },
    async getHandoff() {
      return {
        apiVersion: 1,
        handoff: {
          acceptanceCriteria: [], artifacts: [], constraints: [], context: '',
          createdAt: now, createdBy: { id: owner, kind: 'human' }, decisions: [],
          handoffId: '44444444-4444-4444-8444-444444444444',
          objective: 'Guard Task delivery', requestedMode: 'implement',
          requestedPermissions: {
            delivery: 'pull_request', network: 'restricted', repository: 'write',
            task: 'write', workspace: 'write'
          },
          revision: 1, taskId
        },
        message: 'loaded'
      };
    }
  } as TaskExecutionService;
}

function providerFixture() {
  let observedAt = now;
  let pullRequest: TaskDeliveryProviderObservation['pullRequest'];
  let review: TaskDeliveryProviderObservation['review'] = {
    checkedAt: now, commit: head, fingerprint: 'c'.repeat(64), state: 'required'
  };
  let mergeCommit: string | undefined;
  let taskState: TaskDeliveryProviderObservation['taskState'] = 'open';
  let deployment: TaskDeliveryProviderObservation['deployment'];
  let mergeUncertainOnce = false;
  let completeUncertainOnce = false;
  let mergeCalls = 0;
  let createCalls = 0;
  let reviewCalls = 0;
  let reviewUncertainOnce = false;
  let observeCalls = 0;
  let mergeGate: { gate: Promise<void>; started: () => void } | undefined;
  const observation = (): TaskDeliveryProviderObservation => ({
    checks: {
      commit: pullRequest?.headCommit ?? head,
      fingerprint: 'b'.repeat(64),
      required: [{
        checkedAt: now, commit: pullRequest?.headCommit ?? head,
        id: 'fast-ci', name: 'Fast CI', state: 'passing'
      }],
      state: 'passing'
    },
    completionPolicy: { kind: 'merged' },
    ...(deployment ? { deployment } : {}),
    ...(mergeCommit ? { mergeCommit } : {}),
    observedAt,
    preview: { headCommit: pullRequest?.headCommit ?? head, state: 'ready', url: 'https://preview.example.test/' },
    ...(pullRequest ? { pullRequest } : {}),
    review,
    sourceCommit: pullRequest?.headCommit ?? head,
    taskState
  });
  const provider: TaskDeliveryProvider = {
    async observe() {
      observeCalls += 1;
      return observation();
    },
    async createOrUpdatePullRequest(input) {
      createCalls += 1;
      pullRequest = {
        baseBranch: 'main', draft: input.draft, headCommit: input.expectedHeadCommit,
        number: 562, state: 'open', url: 'https://github.com/DotNaos/project-space/pull/562'
      };
      return { kind: 'confirmed', observation: observation() };
    },
    async requestReview(input) {
      reviewCalls += 1;
      if (reviewUncertainOnce) {
        reviewUncertainOnce = false;
        review = {
          ...review,
          requestFingerprint: taskDeliveryReviewRequestFingerprint({
            headCommit: input.expectedHeadCommit,
            summary: input.summary
          })
        };
        return { kind: 'uncertain', reason: 'lost response' };
      }
      return { kind: 'confirmed', observation: observation() };
    },
    async merge() {
      mergeCalls += 1;
      if (mergeGate) {
        const currentGate = mergeGate;
        mergeGate = undefined;
        currentGate.started();
        await currentGate.gate;
      }
      if (mergeUncertainOnce) {
        mergeUncertainOnce = false;
        pullRequest = { ...pullRequest!, draft: false, state: 'merged' };
        mergeCommit = 'd'.repeat(40);
        return { kind: 'uncertain', reason: 'lost response' };
      }
      pullRequest = { ...pullRequest!, draft: false, state: 'merged' };
      mergeCommit = 'd'.repeat(40);
      return { kind: 'confirmed', observation: observation() };
    },
    async completeTask() {
      if (completeUncertainOnce) {
        completeUncertainOnce = false;
        return { kind: 'uncertain', reason: 'lost response' };
      }
      taskState = 'completed';
      return { kind: 'confirmed', observation: observation() };
    }
  };
  return {
    approve() {
      review = { checkedAt: now, commit: pullRequest!.headCommit,
        fingerprint: 'e'.repeat(64), state: 'approved' };
    },
    changeHead(next: string) {
      pullRequest = { ...pullRequest!, headCommit: next };
      review = { checkedAt: now, commit: next, fingerprint: 'f'.repeat(64), state: 'required' };
    },
    createCalls: () => createCalls,
    deferMerge() {
      let release!: () => void;
      let started!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const didStart = new Promise<void>((resolve) => { started = resolve; });
      mergeGate = { gate, started };
      return { release, started: didStart };
    },
    mergeCalls: () => mergeCalls,
    observeCalls: () => observeCalls,
    provider,
    reviewCalls: () => reviewCalls,
    seedPullRequest(number: number) {
      pullRequest = {
        baseBranch: 'main', draft: false, headCommit: head, number, state: 'open',
        url: `https://github.com/DotNaos/project-space/pull/${number}`
      };
    },
    setDeployment() {
      deployment = {
        deployedCommit: mergeCommit!, environment: 'production', health: 'healthy',
        origin: 'https://projects.example.test/', originFingerprint: '1'.repeat(64),
        originReachable: true, runningVersion: mergeCommit!
      };
    },
    setObservedAt(value: string) { observedAt = value; },
    setReviewFingerprint(value: string) { review = { ...review, requestFingerprint: value }; },
    setTaskCompleted() { taskState = 'completed'; },
    setCompleteUncertainOnce() { completeUncertainOnce = true; },
    setMergeUncertainOnce() { mergeUncertainOnce = true; },
    setReviewUncertainOnce() { reviewUncertainOnce = true; }
  };
}

function fixture(options: {
  completionPolicy?: TaskCompletionPolicy;
  store?: MemoryTaskDeliveryStore;
} = {}) {
  const provider = providerFixture();
  const ids = [deliveryId, reviewId];
  const service = createTaskDeliveryService({
    completionPolicyFor: async () => options.completionPolicy ?? ({ kind: 'merged' }),
    createId: () => ids.shift()!,
    now: () => new Date(now),
    operations: new MemoryTaskExecutionOperationStore(() => Date.parse(now)),
    providerFor: (kind) => kind === 'github' ? provider.provider : undefined,
    store: options.store ?? new MemoryTaskDeliveryStore((_ownerUserId, candidateExecutionId) => (
      [executionId, successorExecutionId].includes(candidateExecutionId)
        ? {
          branch: 'issue-562-delivery', providerKind: 'github',
          repositoryId: '1001', taskId
        }
        : undefined
    )),
    taskExecutions: taskExecutions()
  });
  return { provider, service };
}

async function prepareApprovedPullRequest(value: ReturnType<typeof fixture>) {
  const created = await value.service.createOrUpdatePullRequest({ userId: owner }, {
    executionId, expectedHeadCommit: head, operationId: 'delivery:create:0001',
    presentation: { mode: 'generated' }, state: 'ready'
  });
  expect(created.state).toBe('completed');
  const requested = await value.service.requestReview({ clientId: 'codex', userId: owner }, {
    executionId, expectedHeadCommit: head, expectedPullRequestId: '562',
    operationId: 'delivery:review:0001', summary: 'Ready for exact-head review.'
  });
  expect(requested.delivery?.review?.state).toBe('approval_required');
  value.provider.approve();
  return requested.delivery!.review!.id;
}

describe('Task Delivery service', () => {
  test('finishes PR, review, merge, and Task completion only with exact evidence', async () => {
    const value = fixture();
    const reviewRequestId = await prepareApprovedPullRequest(value);
    const merged = await value.service.mergePullRequest({ userId: owner }, {
      executionId, expectedApprovedRevision: head, expectedHeadCommit: head,
      expectedPullRequestId: '562', mergeMethod: 'squash',
      operationId: 'delivery:merge:0001', reviewRequestId
    });
    expect(merged).toMatchObject({ state: 'completed', delivery: { state: 'merged' } });
    const completed = await value.service.completeTask({ userId: owner }, {
      completionPolicy: 'merged_pull_request', executionId,
      evidence: { deliveryId, mergeOperationId: 'delivery:merge:0001' },
      operationId: 'delivery:complete:0001', taskId
    });
    expect(completed).toMatchObject({
      state: 'completed', task: { id: taskId, state: 'completed' },
      delivery: { state: 'completed' }
    });
    const replayed = await value.service.completeTask({ userId: owner }, {
      completionPolicy: 'merged_pull_request', executionId,
      evidence: { deliveryId, mergeOperationId: 'delivery:merge:0001' },
      operationId: 'delivery:complete:0001', taskId
    });
    expect(replayed.replayed).toBe(true);
  });

  test('rejects stale approval after the pull-request head changes', async () => {
    const value = fixture();
    const reviewRequestId = await prepareApprovedPullRequest(value);
    value.provider.changeHead('9'.repeat(40));
    const result = await value.service.mergePullRequest({ userId: owner }, {
      executionId, expectedApprovedRevision: head, expectedHeadCommit: head,
      expectedPullRequestId: '562', mergeMethod: 'squash',
      operationId: 'delivery:merge:stale', reviewRequestId
    });
    expect(result).toMatchObject({ blockedReason: 'head_mismatch', state: 'blocked' });
    expect(value.provider.mergeCalls()).toBe(0);
  });

  test('reconciles the same uncertain merge operation without allowing a competing dispatch', async () => {
    const value = fixture();
    const reviewRequestId = await prepareApprovedPullRequest(value);
    value.provider.setMergeUncertainOnce();
    const request = {
      executionId, expectedApprovedRevision: head, expectedHeadCommit: head,
      expectedPullRequestId: '562', mergeMethod: 'squash' as const,
      operationId: 'delivery:merge:retry', reviewRequestId
    };
    expect((await value.service.mergePullRequest({ userId: owner }, request)).state).toBe('uncertain');
    expect((await value.service.mergePullRequest({ userId: owner }, request)).state).toBe('completed');
    expect(value.provider.mergeCalls()).toBe(1);
  });

  test('does not dispatch two concurrent exact retries', async () => {
    const value = fixture();
    const reviewRequestId = await prepareApprovedPullRequest(value);
    const deferred = value.provider.deferMerge();
    const request = {
      executionId, expectedApprovedRevision: head, expectedHeadCommit: head,
      expectedPullRequestId: '562', mergeMethod: 'squash' as const,
      operationId: 'delivery:merge:concurrent', reviewRequestId
    };
    const first = value.service.mergePullRequest({ userId: owner }, request);
    await deferred.started;
    const second = await value.service.mergePullRequest({ userId: owner }, request);
    expect(second).toMatchObject({ replayed: true, state: 'uncertain' });
    expect(value.provider.mergeCalls()).toBe(1);
    deferred.release();
    expect((await first).state).toBe('completed');
  });

  test('rejects an expected pull request that differs from the observed unbound pull request', async () => {
    const value = fixture();
    value.provider.seedPullRequest(561);
    const result = await value.service.createOrUpdatePullRequest({ userId: owner }, {
      executionId, expectedHeadCommit: head, expectedPullRequestId: '562',
      operationId: 'delivery:create:wrong-pr', presentation: { mode: 'generated' },
      state: 'ready'
    });
    expect(result).toMatchObject({ blockedReason: 'pull_request_missing', state: 'blocked' });
    expect(value.provider.createCalls()).toBe(0);
  });

  test('allows a successor execution for the same exact target to complete the merged delivery', async () => {
    const value = fixture();
    const reviewRequestId = await prepareApprovedPullRequest(value);
    await value.service.mergePullRequest({ userId: owner }, {
      executionId, expectedApprovedRevision: head, expectedHeadCommit: head,
      expectedPullRequestId: '562', mergeMethod: 'squash',
      operationId: 'delivery:merge:successor', reviewRequestId
    });
    const completed = await value.service.completeTask({ userId: owner }, {
      completionPolicy: 'merged_pull_request', executionId: successorExecutionId,
      evidence: { deliveryId, mergeOperationId: 'delivery:merge:successor' },
      operationId: 'delivery:complete:successor', taskId
    });
    expect(completed).toMatchObject({
      delivery: { executionId: successorExecutionId }, state: 'completed',
      task: { state: 'completed' }
    });
  });

  test('marks post-dispatch persistence failure uncertain and reconciles without another merge', async () => {
    const store = new FailingEvidenceStore();
    const value = fixture({ store });
    const reviewRequestId = await prepareApprovedPullRequest(value);
    store.failNextAppend();
    const request = {
      executionId, expectedApprovedRevision: head, expectedHeadCommit: head,
      expectedPullRequestId: '562', mergeMethod: 'squash' as const,
      operationId: 'delivery:merge:persistence', reviewRequestId
    };
    expect((await value.service.mergePullRequest({ userId: owner }, request)).state).toBe('uncertain');
    expect((await value.service.mergePullRequest({ userId: owner }, request)).state).toBe('completed');
    expect(value.provider.mergeCalls()).toBe(1);
  });

  test('reconciles a lost review response only from the exact provider fingerprint', async () => {
    const value = fixture();
    await value.service.createOrUpdatePullRequest({ userId: owner }, {
      executionId, expectedHeadCommit: head, operationId: 'delivery:create:review-reconcile',
      presentation: { mode: 'generated' }, state: 'ready'
    });
    value.provider.setReviewUncertainOnce();
    const request = {
      executionId, expectedHeadCommit: head, expectedPullRequestId: '562',
      operationId: 'delivery:review:reconcile', summary: 'Exact review marker.'
    };
    expect((await value.service.requestReview({ userId: owner }, request)).state).toBe('uncertain');
    expect((await value.service.requestReview({ userId: owner }, request)).state).toBe('completed');
    expect(value.provider.reviewCalls()).toBe(1);
  });

  test('keeps an uncertain review fenced when the provider fingerprint does not match', async () => {
    const value = fixture();
    await value.service.createOrUpdatePullRequest({ userId: owner }, {
      executionId, expectedHeadCommit: head, operationId: 'delivery:create:review-mismatch',
      presentation: { mode: 'generated' }, state: 'ready'
    });
    value.provider.setReviewUncertainOnce();
    const request = {
      executionId, expectedHeadCommit: head, expectedPullRequestId: '562',
      operationId: 'delivery:review:mismatch', summary: 'Original summary.'
    };
    expect((await value.service.requestReview({ userId: owner }, request)).state).toBe('uncertain');
    value.provider.setReviewFingerprint('f'.repeat(64));
    expect((await value.service.requestReview({ userId: owner }, request)).state).toBe('uncertain');
    expect(value.provider.reviewCalls()).toBe(1);
  });

  test('replays a terminal operation without another provider observation', async () => {
    const value = fixture();
    const request = {
      executionId, expectedHeadCommit: head, operationId: 'delivery:create:terminal-replay',
      presentation: { mode: 'generated' as const }, state: 'ready' as const
    };
    expect((await value.service.createOrUpdatePullRequest({ userId: owner }, request)).state)
      .toBe('completed');
    const observations = value.provider.observeCalls();
    const replay = await value.service.createOrUpdatePullRequest({ userId: owner }, request);
    expect(replay).toMatchObject({ replayed: true, state: 'completed' });
    expect(value.provider.observeCalls()).toBe(observations);
  });

  test('does not project an externally closed Task as complete before its delivery gate', async () => {
    const value = fixture();
    await value.service.createOrUpdatePullRequest({ userId: owner }, {
      executionId, expectedHeadCommit: head, operationId: 'delivery:create:closed-task',
      presentation: { mode: 'generated' }, state: 'ready'
    });
    value.provider.setTaskCompleted();
    const status = await value.service.getStatus({ userId: owner }, { executionId });
    expect(status.deliveries[0]!.state).toBe('completion_blocked');
  });

  test('keeps uncertain completion distinct from a confirmed blocked Task', async () => {
    const value = fixture();
    const reviewRequestId = await prepareApprovedPullRequest(value);
    await value.service.mergePullRequest({ userId: owner }, {
      executionId, expectedApprovedRevision: head, expectedHeadCommit: head,
      expectedPullRequestId: '562', mergeMethod: 'squash',
      operationId: 'delivery:merge:uncertain-complete', reviewRequestId
    });
    value.provider.setCompleteUncertainOnce();
    const result = await value.service.completeTask({ userId: owner }, {
      completionPolicy: 'merged_pull_request', executionId,
      evidence: { deliveryId, mergeOperationId: 'delivery:merge:uncertain-complete' },
      operationId: 'delivery:complete:uncertain', taskId
    });
    expect(result).toMatchObject({ state: 'uncertain' });
    expect(result.completion).toBeUndefined();
    expect(result.task).toBeUndefined();
  });

  test('accepts a requested deployment evidence id after a fresh observation adds a revision', async () => {
    const value = fixture({
      completionPolicy: { deploymentEnvironment: 'production', kind: 'deployed_healthy' }
    });
    const reviewRequestId = await prepareApprovedPullRequest(value);
    await value.service.mergePullRequest({ userId: owner }, {
      executionId, expectedApprovedRevision: head, expectedHeadCommit: head,
      expectedPullRequestId: '562', mergeMethod: 'squash',
      operationId: 'delivery:merge:deployment', reviewRequestId
    });
    value.provider.setDeployment();
    const status = await value.service.getStatus({ userId: owner }, { executionId });
    const deploymentEvidenceId = status.deliveries[0]!.deployments[0]!.id;
    value.provider.setObservedAt('2026-08-09T12:01:00.000Z');
    const completed = await value.service.completeTask({ userId: owner }, {
      completionPolicy: 'verified_deployment', executionId,
      evidence: {
        deliveryId, deploymentEvidenceIds: [deploymentEvidenceId],
        mergeOperationId: 'delivery:merge:deployment'
      },
      operationId: 'delivery:complete:deployment', taskId
    });
    expect(completed.state).toBe('completed');
  });
});
