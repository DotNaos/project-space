import { describe, expect, test } from 'bun:test';

import {
  scopesForTool,
  tools,
  toolSchemas
} from '../server/project-space-mcp/tool-catalog';
import {
  projectSpaceMcpDeliveryMergeScope,
  projectSpaceMcpDeliveryWriteScope,
  projectSpaceMcpReadScope,
  projectSpaceMcpTaskWriteScope,
  projectSpaceMcpWriteScope
} from '../server/project-space-mcp-oauth-store';

const executionId = '11111111-1111-4111-8111-111111111111';
const deliveryId = '22222222-2222-4222-8222-222222222222';
const reviewRequestId = '33333333-3333-4333-8333-333333333333';
const commit = 'a'.repeat(40);
const names = [
  'get_task_delivery_status',
  'create_or_update_task_pull_request',
  'request_task_review',
  'merge_task_pull_request',
  'complete_task'
];

describe('Project Space MCP Task Delivery catalogue', () => {
  test('publishes exactly five tools with strict outputs and truthful annotations', () => {
    const published = tools.filter(({ name }) => names.includes(name));
    expect(published.map(({ name }) => name)).toEqual(names);
    expect(published.map(({ annotations }) => annotations)).toEqual([
      expect.objectContaining({ destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: true }),
      expect.objectContaining({ destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: false }),
      expect.objectContaining({ destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: false }),
      expect.objectContaining({ destructiveHint: true, idempotentHint: true, openWorldHint: true, readOnlyHint: false }),
      expect.objectContaining({ destructiveHint: true, idempotentHint: true, openWorldHint: true, readOnlyHint: false })
    ]);
    for (const entry of published) {
      expect(entry.inputSchema.additionalProperties).toBe(false);
      expect(entry.outputSchema).toMatchObject({
        additionalProperties: false, properties: { result: expect.any(Object) },
        required: ['result'], type: 'object'
      });
      expect(entry._meta?.securitySchemes).toEqual(entry.securitySchemes);
    }
  });

  test('requires only the exact read, delivery-write, merge, or Task-write scopes', () => {
    expect(scopesForTool('get_task_delivery_status')).toEqual([projectSpaceMcpReadScope]);
    for (const name of ['create_or_update_task_pull_request', 'request_task_review']) {
      expect(scopesForTool(name)).toEqual([
        projectSpaceMcpReadScope, projectSpaceMcpWriteScope,
        projectSpaceMcpDeliveryWriteScope
      ]);
    }
    expect(scopesForTool('merge_task_pull_request')).toEqual([
      projectSpaceMcpReadScope, projectSpaceMcpWriteScope,
      projectSpaceMcpDeliveryMergeScope
    ]);
    expect(scopesForTool('complete_task')).toEqual([
      projectSpaceMcpReadScope, projectSpaceMcpWriteScope,
      projectSpaceMcpTaskWriteScope
    ]);
  });

  test('keeps selectors, pull-request content, and review identity unambiguous', () => {
    expect(toolSchemas.get_task_delivery_status.safeParse({ executionId }).success).toBe(true);
    expect(toolSchemas.get_task_delivery_status.safeParse({ taskId: 'github:owner/repo:562', limit: 20 }).success).toBe(true);
    for (const invalid of [
      {}, { executionId, taskId: 'github:owner/repo:562' }, { executionId, cursor: 'next' }
    ]) expect(toolSchemas.get_task_delivery_status.safeParse(invalid).success).toBe(false);

    const base = {
      executionId, expectedHeadCommit: commit, operationId: 'delivery:pull-request:0001',
      presentation: { mode: 'generated' as const }, state: 'draft' as const
    };
    expect(toolSchemas.create_or_update_task_pull_request.safeParse(base).success).toBe(true);
    expect(toolSchemas.create_or_update_task_pull_request.safeParse({
      ...base, presentation: { mode: 'provided', title: 'WP8', body: 'Ready.' }, state: 'ready'
    }).success).toBe(true);
    expect(toolSchemas.create_or_update_task_pull_request.safeParse({
      ...base, presentation: { mode: 'generated', title: 'Caller content' }
    }).success).toBe(false);
    expect(toolSchemas.create_or_update_task_pull_request.safeParse({
      ...base, repositoryId: 'attacker/repo'
    }).success).toBe(false);

    const review = {
      executionId, expectedHeadCommit: commit, expectedPullRequestId: '42',
      operationId: 'delivery:review:0001', summary: 'Ready for human approval.'
    };
    expect(toolSchemas.request_task_review.safeParse(review).success).toBe(true);
    expect(toolSchemas.request_task_review.safeParse({ ...review, approved: true }).success).toBe(false);
  });

  test('requires exact approved revision and stored completion evidence', () => {
    const merge = {
      executionId, expectedApprovedRevision: commit, expectedHeadCommit: commit,
      expectedPullRequestId: '42', mergeMethod: 'squash',
      operationId: 'delivery:merge:0001', reviewRequestId
    };
    expect(toolSchemas.merge_task_pull_request.safeParse(merge).success).toBe(true);
    expect(toolSchemas.merge_task_pull_request.safeParse({
      ...merge, expectedHeadCommit: 'abcdef12'
    }).success).toBe(false);
    expect(toolSchemas.merge_task_pull_request.safeParse({ ...merge, approved: true }).success)
      .toBe(false);

    const complete = {
      completionPolicy: 'merged_pull_request',
      evidence: { deliveryId, mergeOperationId: merge.operationId },
      executionId, operationId: 'delivery:complete:0001', taskId: 'github:owner/repo:562'
    } as const;
    expect(toolSchemas.complete_task.safeParse(complete).success).toBe(true);
    expect(toolSchemas.complete_task.safeParse({
      ...complete, completionPolicy: 'verified_deployment'
    }).success).toBe(false);
    expect(toolSchemas.complete_task.safeParse({
      ...complete, completionPolicy: 'verified_deployment',
      evidence: { ...complete.evidence, deploymentEvidenceIds: ['prod-evidence-1'] }
    }).success).toBe(true);
    expect(toolSchemas.complete_task.safeParse({
      ...complete, evidence: { ...complete.evidence, healthUrl: 'https://attacker.invalid' }
    }).success).toBe(false);
  });
});
