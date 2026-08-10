import { describe, expect, test } from 'bun:test';

import {
  TASK_DELIVERY_MCP_API_VERSION,
  taskCompletionPolicies,
  taskDeliveryBlockedReasons,
  taskDeliveryLifecycleStates,
  taskDeliveryOperationStates,
  taskPullRequestMergeMethods,
  type CompleteTaskRequest,
  type CreateOrUpdateTaskPullRequestRequest,
  type GetTaskDeliveryStatusRequest,
  type MergeTaskPullRequestRequest,
  type RequestTaskReviewRequest,
  type TaskCompletionResult,
  type TaskDeliveryMutationResult,
  type TaskDeliveryProjection,
  type TaskDeliveryStatusResult
} from '../src/shared/task-delivery-mcp-api';

describe('Task Delivery MCP public contract', () => {
  test('publishes stable provider-neutral states and policies', () => {
    expect(TASK_DELIVERY_MCP_API_VERSION).toBe(1);
    expect(taskDeliveryOperationStates).toEqual(['completed', 'blocked', 'uncertain']);
    expect(taskCompletionPolicies).toEqual(['merged_pull_request', 'verified_deployment']);
    expect(taskPullRequestMergeMethods).toEqual(['merge', 'squash', 'rebase']);
    expect(taskDeliveryLifecycleStates).toContain('approval_required');
    expect(taskDeliveryLifecycleStates).toContain('uncertain');
    expect(taskDeliveryBlockedReasons).toContain('approval_stale');
    expect(taskDeliveryBlockedReasons).toContain('running_commit_mismatch');
  });

  test('exports every public request and result shape', () => {
    const requests: [
      GetTaskDeliveryStatusRequest,
      CreateOrUpdateTaskPullRequestRequest,
      RequestTaskReviewRequest,
      MergeTaskPullRequestRequest,
      CompleteTaskRequest
    ] = [
      { executionId: '11111111-1111-4111-8111-111111111111' },
      {
        executionId: '11111111-1111-4111-8111-111111111111',
        expectedHeadCommit: 'a'.repeat(40), operationId: 'delivery:pr:0001',
        presentation: { mode: 'generated' }, state: 'draft'
      },
      {
        executionId: '11111111-1111-4111-8111-111111111111',
        expectedHeadCommit: 'a'.repeat(40), expectedPullRequestId: '42',
        operationId: 'delivery:review:0001', summary: 'Ready for review.'
      },
      {
        executionId: '11111111-1111-4111-8111-111111111111',
        expectedApprovedRevision: 'a'.repeat(40), expectedHeadCommit: 'a'.repeat(40),
        expectedPullRequestId: '42', mergeMethod: 'squash',
        operationId: 'delivery:merge:0001',
        reviewRequestId: '22222222-2222-4222-8222-222222222222'
      },
      {
        completionPolicy: 'merged_pull_request',
        evidence: {
          deliveryId: '33333333-3333-4333-8333-333333333333',
          mergeOperationId: 'delivery:merge:0001'
        },
        executionId: '11111111-1111-4111-8111-111111111111',
        operationId: 'delivery:complete:0001', taskId: 'github:owner/repo:562'
      }
    ];
    const projections = [] as TaskDeliveryProjection[];
    const results: Array<TaskDeliveryStatusResult | TaskDeliveryMutationResult | TaskCompletionResult> = [
      { apiVersion: 1, deliveries: projections },
      {
        apiVersion: 1, message: 'Blocked.', operationId: 'delivery:merge:0001',
        replayed: false, state: 'blocked', blockedReason: 'approval_required'
      }
    ];
    expect(requests).toHaveLength(5);
    expect(results).toHaveLength(2);
  });
});
