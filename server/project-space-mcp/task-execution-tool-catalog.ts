import { z } from 'zod';

import {
  projectSpaceMcpExecutionApproveScope,
  projectSpaceMcpExecutionWriteScope,
  projectSpaceMcpReadScope,
  projectSpaceMcpWriteScope
} from '../project-space-mcp-oauth-store';
import { defineOAuthTool } from './tool-definition';

const operationIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const operationIdJsonPattern = '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$';
const agentSchema = z.literal('codex');
const executionIdSchema = z.string().uuid();
const operationIdSchema = z.string().regex(operationIdPattern);
const taskExecutionStates = [
  'planned', 'preparing_environment', 'waiting_for_connector',
  'waiting_for_authorization', 'preparing_workspace', 'starting_agent', 'running',
  'waiting_for_approval', 'waiting_for_input', 'verifying', 'delivering', 'blocked',
  'uncertain', 'completed', 'failed', 'cancelled', 'archived'
] as const;

const handoffReferenceSchema = z.object({
  id: z.string().uuid(),
  revision: z.number().int().positive()
}).strict();
const briefingSchema = z.object({
  acceptanceCriteria: z.array(z.string().trim().min(1).max(4_000)).max(100).optional(),
  constraints: z.array(z.string().trim().min(1).max(4_000)).max(100).optional(),
  context: z.string().max(60_000).optional(),
  decisions: z.array(z.string().trim().min(1).max(4_000)).max(100).optional(),
  objective: z.string().trim().min(1).max(12_000),
  requestedMode: z.enum(['implement', 'plan', 'repair', 'review']).optional()
}).strict();
const taskLocatorSchema = z.object({
  number: z.number().int().positive(),
  provider: z.literal('github'),
  repositoryId: z.string().trim().min(1).max(512)
}).strict();

export const taskExecutionToolSchemas = {
  start_task_execution: z.object({
    agent: agentSchema.optional(),
    briefing: briefingSchema.optional(),
    dryRun: z.boolean().optional(),
    environmentId: executionIdSchema,
    handoff: handoffReferenceSchema.optional(),
    operationId: operationIdSchema,
    task: taskLocatorSchema
  }).strict().superRefine((value, context) => {
    if (value.briefing && value.handoff) {
      context.addIssue({
        code: 'custom',
        message: 'Select one existing Handoff or one inline briefing.'
      });
    }
  }),
  list_task_executions: z.object({
    agent: agentSchema.optional(),
    cursor: z.string().min(1).max(2_048).optional(),
    environmentId: executionIdSchema.optional(),
    includeArchived: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    state: z.enum(taskExecutionStates).optional(),
    taskId: z.string().trim().min(1).max(512).optional()
  }).strict(),
  get_task_execution: z.object({
    afterCursor: z.number().int().min(0).optional(),
    executionId: executionIdSchema,
    limit: z.number().int().min(1).max(200).optional()
  }).strict(),
  wait_task_execution: z.object({
    executions: z.array(z.object({
      afterCursor: z.number().int().min(0).optional(),
      executionId: executionIdSchema
    }).strict()).min(1).max(8),
    timeoutSeconds: z.number().int().min(0).max(30).optional()
  }).strict(),
  send_task_execution_message: z.object({
    executionId: executionIdSchema,
    message: z.string().trim().min(1).max(100_000),
    operationId: operationIdSchema,
    wait: z.boolean().optional()
  }).strict(),
  respond_task_execution_approval: z.object({
    approvalId: z.string().trim().min(1).max(256).optional(),
    decision: z.enum(['allow-once', 'deny']),
    executionId: executionIdSchema,
    itemId: z.string().trim().min(1).max(256).optional(),
    operationId: operationIdSchema,
    requestId: z.string().trim().min(1).max(256),
    turnId: z.string().trim().min(1).max(256)
  }).strict(),
  respond_task_execution_input: z.object({
    answers: z.array(z.object({
      questionId: z.string().trim().min(1).max(256),
      value: z.string().max(20_000)
    }).strict()).min(1).max(50),
    executionId: executionIdSchema,
    operationId: operationIdSchema,
    requestId: z.string().trim().min(1).max(256),
    turnId: z.string().trim().min(1).max(256)
  }).strict(),
  cancel_task_execution: z.object({
    executionId: executionIdSchema,
    operationId: operationIdSchema,
    reason: z.string().trim().min(1).max(500).optional()
  }).strict(),
  archive_task_execution: z.object({
    executionId: executionIdSchema,
    operationId: operationIdSchema
  }).strict()
};

const writeScopes = [
  projectSpaceMcpReadScope,
  projectSpaceMcpWriteScope,
  projectSpaceMcpExecutionWriteScope
] as const;
const approvalScopes = [
  projectSpaceMcpReadScope,
  projectSpaceMcpWriteScope,
  projectSpaceMcpExecutionApproveScope
] as const;
const mutationProperties = {
  executionId: { type: 'string', format: 'uuid', description: 'Canonical Task Execution id.' },
  operationId: {
    type: 'string', minLength: 8, maxLength: 128, pattern: operationIdJsonPattern,
    description: 'Caller-supplied idempotency key for this exact mutation.'
  }
} as const;
const environmentIdProperty = {
  type: 'string', format: 'uuid', description: 'Canonical execution Environment id.'
} as const;
const executionProjectionSchema = {
  type: 'object',
  required: ['agent', 'createdAt', 'environmentId', 'handoff', 'id', 'source', 'state', 'updatedAt', 'version'],
  properties: {
    agent: { type: 'string', enum: ['codex'] },
    blockedReason: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
    environmentId: { type: 'string', format: 'uuid' },
    handoff: { type: 'object' }, id: { type: 'string', format: 'uuid' },
    source: { type: 'object' }, state: { type: 'string', enum: taskExecutionStates },
    updatedAt: { type: 'string', format: 'date-time' }, version: { type: 'integer', minimum: 1 }
  }
} as const;
const executionResultSchema = {
  type: 'object', required: ['apiVersion', 'events', 'execution', 'message'],
  properties: {
    apiVersion: { type: 'integer', enum: [1] }, events: { type: 'array', items: { type: 'object' } },
    execution: executionProjectionSchema, message: { type: 'string' },
    nextCursor: { type: 'integer' }, operationId: { type: 'string' }, replayed: { type: 'boolean' }
  }
} as const;
const output = (result: object) => ({
  type: 'object' as const,
  required: ['result'],
  properties: { result }
});
const executionOutput = output(executionResultSchema);
const listOutput = output({
  type: 'object', required: ['apiVersion', 'executions'], properties: {
    apiVersion: { type: 'integer', enum: [1] },
    executions: { type: 'array', items: executionProjectionSchema }, nextCursor: { type: 'string' }
  }
});
const waitOutput = output({
  type: 'object', required: ['apiVersion', 'executions', 'timedOut'], properties: {
    apiVersion: { type: 'integer', enum: [1] },
    executions: { type: 'array', items: executionResultSchema }, timedOut: { type: 'boolean' }
  }
});
const startOutput = output({
  oneOf: [executionResultSchema, {
    type: 'object', required: [
      'apiVersion', 'dryRun', 'environmentId', 'handoff', 'message', 'operationId',
      'prerequisites', 'source', 'state'
    ], properties: {
      apiVersion: { type: 'integer', enum: [1] }, dryRun: { type: 'boolean', enum: [true] },
      environmentId: { type: 'string', format: 'uuid' }, handoff: { type: 'object' },
      message: { type: 'string' }, operationId: { type: 'string' }, prerequisites: { type: 'object' },
      source: { type: 'object' }, state: { type: 'string', enum: ['blocked', 'ready'] }
    }
  }]
});

export const taskExecutionTools = [
  defineOAuthTool('start_task_execution', 'Start task execution', 'Start or resume one provider-neutral Task Execution. The normal path owns Environment start, readiness, authorization checks, workspace preparation, capacity, and agent start.', {
    type: 'object', required: ['environmentId', 'operationId', 'task'],
    allOf: [{ not: { required: ['briefing', 'handoff'] } }],
    properties: {
      agent: { type: 'string', enum: ['codex'], default: 'codex' },
      briefing: { type: 'object', required: ['objective'], additionalProperties: false, properties: {
        acceptanceCriteria: { type: 'array', maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 4_000 } },
        constraints: { type: 'array', maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 4_000 } },
        context: { type: 'string', maxLength: 60_000 }, decisions: { type: 'array', maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 4_000 } },
        objective: { type: 'string', minLength: 1, maxLength: 12_000 }, requestedMode: { type: 'string', enum: ['implement', 'plan', 'repair', 'review'] }
      } },
      dryRun: { type: 'boolean', description: 'Check the full target without creating a branch, workspace, thread, or execution.' },
      environmentId: environmentIdProperty,
      handoff: { type: 'object', required: ['id', 'revision'], additionalProperties: false, properties: {
        id: { type: 'string', format: 'uuid' }, revision: { type: 'integer', minimum: 1 }
      } },
      operationId: mutationProperties.operationId,
      task: { type: 'object', required: ['number', 'provider', 'repositoryId'], additionalProperties: false, properties: {
        number: { type: 'integer', minimum: 1 }, provider: { type: 'string', enum: ['github'] },
        repositoryId: { type: 'string', minLength: 1, maxLength: 512 }
      } }
    }, additionalProperties: false
  }, { destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: false }, writeScopes, startOutput),
  defineOAuthTool('list_task_executions', 'List task executions', 'List the signed-in user’s provider-neutral Task Executions with stable filters and cursor pagination.', {
    type: 'object', additionalProperties: false, properties: {
      agent: { type: 'string', enum: ['codex'] }, cursor: { type: 'string', minLength: 1, maxLength: 2_048 },
      environmentId: { type: 'string', format: 'uuid' }, includeArchived: { type: 'boolean' },
      limit: { type: 'integer', minimum: 1, maximum: 100 }, state: { type: 'string', enum: taskExecutionStates },
      taskId: { type: 'string', minLength: 1, maxLength: 512 }
    }
  }, { destructiveHint: false, idempotentHint: true, openWorldHint: false, readOnlyHint: true }, undefined, listOutput),
  defineOAuthTool('get_task_execution', 'Get task execution', 'Read one exact Task Execution, its durable events, current attention request, workspace, executor binding, and fresh executor activity.', {
    type: 'object', required: ['executionId'], additionalProperties: false, properties: {
      afterCursor: { type: 'integer', minimum: 0 }, executionId: mutationProperties.executionId,
      limit: { type: 'integer', minimum: 1, maximum: 200 }
    }
  }, { destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: true }, undefined, executionOutput),
  defineOAuthTool('wait_task_execution', 'Wait for task execution', 'Wait for one or more Task Executions to complete, fail, become uncertain, or require approval or input.', {
    type: 'object', required: ['executions'], additionalProperties: false, properties: {
      executions: { type: 'array', minItems: 1, maxItems: 8, items: {
        type: 'object', required: ['executionId'], additionalProperties: false, properties: {
          afterCursor: { type: 'integer', minimum: 0 }, executionId: mutationProperties.executionId
        }
      } }, timeoutSeconds: { type: 'integer', minimum: 0, maximum: 30 }
    }
  }, { destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: true }, undefined, waitOutput),
  defineOAuthTool('send_task_execution_message', 'Send task execution message', 'Send one idempotent follow-up message to the executor bound to an exact Task Execution.', {
    type: 'object', required: ['executionId', 'message', 'operationId'], additionalProperties: false, properties: {
      ...mutationProperties, message: { type: 'string', minLength: 1, maxLength: 100_000 }, wait: { type: 'boolean' }
    }
  }, { destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: false }, writeScopes, executionOutput),
  defineOAuthTool('respond_task_execution_approval', 'Respond to task execution approval', 'Respond only to the exact pending approval request, turn, and item identities. No default approval is invented.', {
    type: 'object', required: ['decision', 'executionId', 'operationId', 'requestId', 'turnId'], additionalProperties: false, properties: {
      ...mutationProperties, approvalId: { type: 'string', minLength: 1, maxLength: 256 },
      decision: { type: 'string', enum: ['allow-once', 'deny'] }, itemId: { type: 'string', minLength: 1, maxLength: 256 },
      requestId: { type: 'string', minLength: 1, maxLength: 256 }, turnId: { type: 'string', minLength: 1, maxLength: 256 }
    }
  }, { destructiveHint: true, idempotentHint: true, openWorldHint: true, readOnlyHint: false }, approvalScopes, executionOutput),
  defineOAuthTool('respond_task_execution_input', 'Respond to task execution input', 'Answer the exact currently pending questions for one Task Execution and turn.', {
    type: 'object', required: ['answers', 'executionId', 'operationId', 'requestId', 'turnId'], additionalProperties: false, properties: {
      ...mutationProperties, answers: { type: 'array', minItems: 1, maxItems: 50, items: {
        type: 'object', required: ['questionId', 'value'], additionalProperties: false, properties: {
          questionId: { type: 'string', minLength: 1, maxLength: 256 }, value: { type: 'string', maxLength: 20_000 }
        }
      } }, requestId: { type: 'string', minLength: 1, maxLength: 256 }, turnId: { type: 'string', minLength: 1, maxLength: 256 }
    }
  }, { destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: false }, approvalScopes, executionOutput),
  defineOAuthTool('cancel_task_execution', 'Cancel task execution', 'Cancel one exact Task Execution. Capacity is released only after a confirmed terminal executor outcome.', {
    type: 'object', required: ['executionId', 'operationId'], additionalProperties: false, properties: {
      ...mutationProperties, reason: { type: 'string', minLength: 1, maxLength: 500 }
    }
  }, { destructiveHint: true, idempotentHint: true, openWorldHint: true, readOnlyHint: false }, writeScopes, executionOutput),
  defineOAuthTool('archive_task_execution', 'Archive task execution', 'Archive a terminal Task Execution without deleting its audit, Handoff, workspace, or delivery evidence.', {
    type: 'object', required: ['executionId', 'operationId'], additionalProperties: false,
    properties: mutationProperties
  }, { destructiveHint: false, idempotentHint: true, openWorldHint: false, readOnlyHint: false }, writeScopes, executionOutput)
];
