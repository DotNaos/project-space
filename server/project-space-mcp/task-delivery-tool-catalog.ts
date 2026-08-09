import { z } from 'zod';

import {
  TASK_DELIVERY_MCP_API_VERSION,
  taskCompletionPolicies,
  taskDeliveryBlockedReasons,
  taskDeliveryLifecycleStates,
  taskDeliveryOperationStates,
  taskPullRequestMergeMethods
} from '../../src/shared/task-delivery-mcp-api';
import {
  projectSpaceMcpDeliveryMergeScope,
  projectSpaceMcpDeliveryWriteScope,
  projectSpaceMcpReadScope,
  projectSpaceMcpTaskWriteScope,
  projectSpaceMcpWriteScope
} from '../project-space-mcp-oauth-store';
import { defineOAuthTool } from './tool-definition';

const operationIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const operationIdJsonPattern = '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$';
const commitPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const commitJsonPattern = '^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$';
const opaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const opaqueIdJsonPattern = '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$';
const executionIdSchema = z.string().uuid();
const operationIdSchema = z.string().regex(operationIdPattern);
const commitSchema = z.string().regex(commitPattern);
const opaqueIdSchema = z.string().regex(opaqueIdPattern);

const presentationSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('generated') }).strict(),
  z.object({
    body: z.string().max(100_000).optional(),
    mode: z.literal('provided'),
    title: z.string().trim().min(1).max(1_000)
  }).strict()
]);

const completionEvidenceSchema = z.object({
  deliveryId: z.string().uuid(),
  deploymentEvidenceIds: z.array(opaqueIdSchema).min(1).max(20).optional(),
  mergeOperationId: operationIdSchema
}).strict();

export const taskDeliveryToolSchemas = {
  get_task_delivery_status: z.object({
    cursor: z.string().min(1).max(2_048).optional(),
    executionId: executionIdSchema.optional(),
    limit: z.number().int().min(1).max(100).optional(),
    taskId: z.string().trim().min(1).max(512).optional()
  }).strict().superRefine((value, context) => {
    if (Boolean(value.executionId) === Boolean(value.taskId)) {
      context.addIssue({ code: 'custom', message: 'Select exactly one executionId or taskId.' });
    }
    if (value.executionId && (value.cursor || value.limit)) {
      context.addIssue({
        code: 'custom', message: 'Pagination is available only for a Task delivery inventory.'
      });
    }
  }),
  create_or_update_task_pull_request: z.object({
    executionId: executionIdSchema,
    expectedHeadCommit: commitSchema,
    expectedPullRequestId: opaqueIdSchema.optional(),
    operationId: operationIdSchema,
    presentation: presentationSchema,
    state: z.enum(['draft', 'ready'])
  }).strict(),
  request_task_review: z.object({
    executionId: executionIdSchema,
    expectedHeadCommit: commitSchema,
    expectedPullRequestId: opaqueIdSchema,
    operationId: operationIdSchema,
    summary: z.string().trim().min(1).max(20_000)
  }).strict(),
  merge_task_pull_request: z.object({
    executionId: executionIdSchema,
    expectedApprovedRevision: commitSchema,
    expectedHeadCommit: commitSchema,
    expectedPullRequestId: opaqueIdSchema,
    mergeMethod: z.enum(taskPullRequestMergeMethods),
    operationId: operationIdSchema,
    reviewRequestId: z.string().uuid()
  }).strict(),
  complete_task: z.object({
    completionPolicy: z.enum(taskCompletionPolicies),
    evidence: completionEvidenceSchema,
    executionId: executionIdSchema,
    operationId: operationIdSchema,
    taskId: z.string().trim().min(1).max(512)
  }).strict().superRefine((value, context) => {
    if (
      value.completionPolicy === 'verified_deployment' &&
      !value.evidence.deploymentEvidenceIds?.length
    ) {
      context.addIssue({
        code: 'custom', path: ['evidence', 'deploymentEvidenceIds'],
        message: 'Verified deployment completion requires stored deployment evidence.'
      });
    }
  })
};

const readScopes = [projectSpaceMcpReadScope] as const;
const deliveryWriteScopes = [
  projectSpaceMcpReadScope, projectSpaceMcpWriteScope, projectSpaceMcpDeliveryWriteScope
] as const;
const deliveryMergeScopes = [
  projectSpaceMcpReadScope, projectSpaceMcpWriteScope, projectSpaceMcpDeliveryMergeScope
] as const;
const taskWriteScopes = [
  projectSpaceMcpReadScope, projectSpaceMcpWriteScope, projectSpaceMcpTaskWriteScope
] as const;

const executionIdProperty = {
  type: 'string', format: 'uuid', description: 'Canonical Task Execution id.'
} as const;
const operationIdProperty = {
  type: 'string', minLength: 8, maxLength: 128, pattern: operationIdJsonPattern,
  description: 'Caller-supplied idempotency key for this exact mutation.'
} as const;
const commitProperty = {
  type: 'string', pattern: commitJsonPattern,
  description: 'Exact full Git commit id; abbreviated revisions are rejected.'
} as const;
const pullRequestIdProperty = {
  type: 'string', minLength: 1, maxLength: 256, pattern: opaqueIdJsonPattern,
  description: 'Expected provider pull-request id already bound to this Execution.'
} as const;
const safeHttpsProperty = {
  type: 'string', format: 'uri', pattern: '^https://',
  description: 'Sanitized HTTPS URL without embedded credentials.'
} as const;

const checkSchema = {
  type: 'object', additionalProperties: false,
  required: ['id', 'name', 'state'],
  properties: {
    id: { type: 'string' }, name: { type: 'string' },
    state: { type: 'string', enum: ['pending', 'passing', 'failing', 'unavailable'] },
    url: safeHttpsProperty
  }
} as const;
const deploymentSchema = {
  type: 'object', additionalProperties: false,
  required: ['checkedAt', 'environment', 'expectedCommit', 'health', 'id', 'state'],
  properties: {
    checkedAt: { type: 'string', format: 'date-time' }, environment: { type: 'string' },
    expectedCommit: commitProperty, health: { type: 'string', enum: ['healthy', 'unhealthy', 'unknown'] },
    id: { type: 'string' }, origin: safeHttpsProperty, runningCommit: commitProperty,
    state: { type: 'string', enum: ['pending', 'running', 'failed', 'unavailable'] },
    version: { type: 'string' }
  }
} as const;
const deliveryProjectionSchema = {
  type: 'object', additionalProperties: false,
  required: [
    'branch', 'checkedAt', 'deployments', 'executionId', 'id', 'repositoryId',
    'state', 'taskId', 'updatedAt'
  ],
  properties: {
    branch: { type: 'string' }, checkedAt: { type: 'string', format: 'date-time' },
    checks: {
      type: 'object', additionalProperties: false,
      required: ['checkedAt', 'checks', 'commit', 'state'],
      properties: {
        checkedAt: { type: 'string', format: 'date-time' },
        checks: { type: 'array', items: checkSchema }, commit: commitProperty,
        state: { type: 'string', enum: ['pending', 'passing', 'failing', 'unverified'] }
      }
    },
    deployments: { type: 'array', items: deploymentSchema }, executionId: executionIdProperty,
    headCommit: commitProperty, id: { type: 'string', format: 'uuid' },
    merge: {
      type: 'object', additionalProperties: false, required: ['checkedAt', 'headCommit', 'state'],
      properties: {
        checkedAt: { type: 'string', format: 'date-time' }, headCommit: commitProperty,
        mergeCommit: commitProperty,
        state: { type: 'string', enum: ['not_started', 'ready', 'merging', 'merged', 'blocked', 'uncertain', 'failed'] }
      }
    },
    preview: {
      type: 'object', additionalProperties: false, required: ['checkedAt', 'commit', 'state'],
      properties: {
        checkedAt: { type: 'string', format: 'date-time' }, commit: commitProperty,
        state: { type: 'string', enum: ['not_required', 'pending', 'ready', 'failed', 'unavailable'] },
        url: safeHttpsProperty
      }
    },
    pullRequest: {
      type: 'object', additionalProperties: false,
      required: ['baseBranch', 'checkedAt', 'headCommit', 'id', 'state'],
      properties: {
        baseBranch: { type: 'string' }, checkedAt: { type: 'string', format: 'date-time' },
        headCommit: commitProperty, id: { type: 'string' }, number: { type: 'integer', minimum: 1 },
        state: { type: 'string', enum: ['draft', 'open', 'closed', 'merged'] },
        url: safeHttpsProperty
      }
    },
    repositoryId: { type: 'string' },
    review: {
      type: 'object', additionalProperties: false,
      required: ['id', 'requestedAt', 'revision', 'state'],
      properties: {
        approvalUrl: safeHttpsProperty, approvedAt: { type: 'string', format: 'date-time' },
        id: { type: 'string', format: 'uuid' },
        requestedAt: { type: 'string', format: 'date-time' }, revision: commitProperty,
        state: { type: 'string', enum: ['approval_required', 'approved', 'changes_requested', 'stale'] }
      }
    },
    rollback: {
      type: 'object', additionalProperties: false, required: ['available', 'checkedAt'],
      properties: {
        available: { type: 'boolean' }, checkedAt: { type: 'string', format: 'date-time' },
        commit: commitProperty
      }
    },
    state: { type: 'string', enum: taskDeliveryLifecycleStates },
    taskId: { type: 'string' }, updatedAt: { type: 'string', format: 'date-time' }
  }
} as const;

const output = (result: object) => ({
  type: 'object' as const, additionalProperties: false, required: ['result'],
  properties: { result }
});
const statusOutput = output({
  type: 'object', additionalProperties: false, required: ['apiVersion', 'deliveries'],
  properties: {
    apiVersion: { type: 'integer', enum: [TASK_DELIVERY_MCP_API_VERSION] },
    deliveries: { type: 'array', items: deliveryProjectionSchema }, nextCursor: { type: 'string' }
  }
});
const mutationProperties = {
  apiVersion: { type: 'integer', enum: [TASK_DELIVERY_MCP_API_VERSION] },
  blockedReason: { type: 'string', enum: taskDeliveryBlockedReasons },
  delivery: deliveryProjectionSchema, message: { type: 'string' }, operationId: { type: 'string' },
  replayed: { type: 'boolean' }, state: { type: 'string', enum: taskDeliveryOperationStates }
} as const;
const mutationOutput = output({
  type: 'object', additionalProperties: false,
  required: ['apiVersion', 'message', 'operationId', 'replayed', 'state'],
  properties: mutationProperties
});
const completionOutput = output({
  type: 'object', additionalProperties: false,
  required: ['apiVersion', 'message', 'operationId', 'replayed', 'state'],
  properties: {
    ...mutationProperties,
    completion: {
      type: 'object', additionalProperties: false, required: ['evidence', 'policy', 'state'],
      properties: {
        completedAt: { type: 'string', format: 'date-time' },
        evidence: {
          type: 'object', additionalProperties: false,
          required: ['deliveryId', 'mergeOperationId'],
          properties: {
            deliveryId: { type: 'string', format: 'uuid' },
            deploymentEvidenceIds: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string' } },
            mergeOperationId: { type: 'string' }
          }
        },
        policy: { type: 'string', enum: taskCompletionPolicies },
        state: { type: 'string', enum: ['blocked', 'completed'] }
      }
    },
    task: {
      type: 'object', additionalProperties: false, required: ['id', 'state'],
      properties: { id: { type: 'string' }, state: { type: 'string', enum: ['open', 'completed'] } }
    }
  }
});

export const taskDeliveryTools = [
  defineOAuthTool('get_task_delivery_status', 'Get task delivery status', 'Read stored and freshly verified delivery evidence for one exact Task Execution or every delivery attempt for one Task.', {
    type: 'object', additionalProperties: false,
    oneOf: [
      { required: ['executionId'], not: { anyOf: [{ required: ['taskId'] }, { required: ['cursor'] }, { required: ['limit'] }] } },
      { required: ['taskId'], not: { required: ['executionId'] } }
    ],
    properties: {
      cursor: { type: 'string', minLength: 1, maxLength: 2_048 }, executionId: executionIdProperty,
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      taskId: { type: 'string', minLength: 1, maxLength: 512, description: 'Canonical provider-neutral Task id.' }
    }
  }, { destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: true }, readScopes, statusOutput),
  defineOAuthTool('create_or_update_task_pull_request', 'Create or update task pull request', 'Create or update the pull request bound to one exact Task Execution and commit. Existing provider state is reconciled before creation.', {
    type: 'object', additionalProperties: false,
    required: ['executionId', 'expectedHeadCommit', 'operationId', 'presentation', 'state'],
    properties: {
      executionId: executionIdProperty, expectedHeadCommit: commitProperty,
      expectedPullRequestId: pullRequestIdProperty, operationId: operationIdProperty,
      presentation: {
        oneOf: [
          { type: 'object', additionalProperties: false, required: ['mode'], properties: { mode: { type: 'string', enum: ['generated'] } } },
          { type: 'object', additionalProperties: false, required: ['mode', 'title'], properties: {
            body: { type: 'string', maxLength: 100_000 }, mode: { type: 'string', enum: ['provided'] },
            title: { type: 'string', minLength: 1, maxLength: 1_000 }
          } }
        ]
      },
      state: { type: 'string', enum: ['draft', 'ready'] }
    }
  }, { destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: false }, deliveryWriteScopes, mutationOutput),
  defineOAuthTool('request_task_review', 'Request task review', 'Present one exact pull-request revision for human approval. This tool records a review request and never grants approval.', {
    type: 'object', additionalProperties: false,
    required: ['executionId', 'expectedHeadCommit', 'expectedPullRequestId', 'operationId', 'summary'],
    properties: {
      executionId: executionIdProperty, expectedHeadCommit: commitProperty,
      expectedPullRequestId: pullRequestIdProperty, operationId: operationIdProperty,
      summary: { type: 'string', minLength: 1, maxLength: 20_000 }
    }
  }, { destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: false }, deliveryWriteScopes, mutationOutput),
  defineOAuthTool('merge_task_pull_request', 'Merge task pull request', 'Merge only the exact currently approved pull-request revision after fresh required-check and review verification.', {
    type: 'object', additionalProperties: false,
    required: [
      'executionId', 'expectedApprovedRevision', 'expectedHeadCommit',
      'expectedPullRequestId', 'mergeMethod', 'operationId', 'reviewRequestId'
    ],
    properties: {
      executionId: executionIdProperty, expectedApprovedRevision: commitProperty,
      expectedHeadCommit: commitProperty, expectedPullRequestId: pullRequestIdProperty,
      mergeMethod: { type: 'string', enum: taskPullRequestMergeMethods }, operationId: operationIdProperty,
      reviewRequestId: { type: 'string', format: 'uuid' }
    }
  }, { destructiveHint: true, idempotentHint: true, openWorldHint: true, readOnlyHint: false }, deliveryMergeScopes, mutationOutput),
  defineOAuthTool('complete_task', 'Complete task', 'Complete the provider Task only after stored evidence satisfies the configured delivery policy. Caller evidence cannot weaken that policy.', {
    type: 'object', additionalProperties: false,
    required: ['completionPolicy', 'evidence', 'executionId', 'operationId', 'taskId'],
    properties: {
      completionPolicy: { type: 'string', enum: taskCompletionPolicies },
      evidence: {
        type: 'object', additionalProperties: false, required: ['deliveryId', 'mergeOperationId'],
        properties: {
          deliveryId: { type: 'string', format: 'uuid' },
          deploymentEvidenceIds: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 256, pattern: opaqueIdJsonPattern } },
          mergeOperationId: operationIdProperty
        }
      },
      executionId: executionIdProperty, operationId: operationIdProperty,
      taskId: { type: 'string', minLength: 1, maxLength: 512 }
    },
    allOf: [{
      if: { properties: { completionPolicy: { const: 'verified_deployment' } } },
      then: { properties: { evidence: { required: ['deploymentEvidenceIds'] } } }
    }]
  }, { destructiveHint: true, idempotentHint: true, openWorldHint: true, readOnlyHint: false }, taskWriteScopes, completionOutput)
];
