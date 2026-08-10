import { z } from 'zod';

import {
  projectSpaceMcpExecutionWriteScope,
  projectSpaceMcpReadScope,
  projectSpaceMcpTaskWriteScope,
  projectSpaceMcpWriteScope
} from '../project-space-mcp-oauth-store';
import { defineOAuthTool } from './tool-definition';

const operationIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const operationIdJsonPattern = '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$';
const artifactIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const artifactIdJsonPattern = '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$';
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const digestJsonPattern = '^sha256:[0-9a-f]{64}$';
const mediaTypePattern = /^[A-Za-z0-9][A-Za-z0-9.+-]*\/[A-Za-z0-9][A-Za-z0-9.+-]*$/;
const mediaTypeJsonPattern = '^[A-Za-z0-9][A-Za-z0-9.+-]*/[A-Za-z0-9][A-Za-z0-9.+-]*$';
const artifactKinds = ['decision', 'design', 'document', 'other', 'screenshot'] as const;
const modes = ['implement', 'plan', 'repair', 'review'] as const;
const uuidSchema = z.string().uuid();
const operationIdSchema = z.string().regex(operationIdPattern);
const taskLocatorSchema = z.object({
  number: z.number().int().positive(),
  provider: z.literal('github'),
  repositoryId: z.string().trim().min(1).max(512)
}).strict();
const requestedPermissionsSchema = z.object({
  delivery: z.enum(['none', 'pull_request']),
  network: z.enum(['none', 'restricted', 'open']),
  repository: z.enum(['read', 'write']),
  task: z.enum(['read', 'write']),
  workspace: z.enum(['read', 'write'])
}).strict();
const inlineArtifactSchema = z.object({
  digest: z.string().regex(digestPattern),
  id: z.string().regex(artifactIdPattern),
  kind: z.enum(artifactKinds),
  mediaType: z.string().max(128).regex(mediaTypePattern),
  name: z.string().trim().min(1).max(512),
  sizeBytes: z.number().int().min(0).max(8 * 1024 * 1024),
  source: z.discriminatedUnion('encoding', [
    z.object({
      data: z.string().max(8 * 1024 * 1024),
      encoding: z.literal('utf8'),
      kind: z.literal('inline')
    }).strict(),
    z.object({
      data: z.string().max(11_184_812).regex(
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
      ),
      encoding: z.literal('base64'),
      kind: z.literal('inline')
    }).strict()
  ])
}).strict();
const existingArtifactSchema = z.object({
  id: z.string().regex(artifactIdPattern),
  source: z.object({
    artifactId: z.string().regex(artifactIdPattern),
    handoffId: uuidSchema,
    kind: z.literal('handoff'),
    revision: z.number().int().positive()
  }).strict()
}).strict();
const artifactSchema = z.union([inlineArtifactSchema, existingArtifactSchema]);

export const taskHandoffToolSchemas = {
  create_task_handoff: z.object({
    acceptanceCriteria: z.array(z.string().trim().min(1).max(4_000)).max(100).optional(),
    artifacts: z.array(artifactSchema).max(32).optional(),
    baseRevision: z.number().int().positive().optional(),
    constraints: z.array(z.string().trim().min(1).max(4_000)).max(100).optional(),
    context: z.string().max(60_000).optional(),
    decisions: z.array(z.string().trim().min(1).max(4_000)).max(100).optional(),
    handoffId: uuidSchema.optional(),
    objective: z.string().trim().min(1).max(12_000),
    operationId: operationIdSchema,
    requestedMode: z.enum(modes),
    requestedPermissions: requestedPermissionsSchema,
    task: taskLocatorSchema
  }).strict().superRefine((value, context) => {
    if ((value.handoffId === undefined) !== (value.baseRevision === undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'Provide both handoffId and baseRevision to append a revision.'
      });
    }
    if (value.artifacts && new Set(value.artifacts.map(({ id }) => id)).size !==
        value.artifacts.length) {
      context.addIssue({ code: 'custom', message: 'Artifact IDs must be unique.' });
    }
  }),
  get_task_handoff: z.object({
    handoffId: uuidSchema,
    revision: z.number().int().positive().optional()
  }).strict(),
  update_task_execution_handoff: z.object({
    executionId: uuidSchema,
    handoffId: uuidSchema,
    operationId: operationIdSchema,
    revision: z.number().int().positive()
  }).strict()
};

const writeScopes = [
  projectSpaceMcpReadScope,
  projectSpaceMcpWriteScope,
  projectSpaceMcpTaskWriteScope
] as const;
const updateScopes = [...writeScopes, projectSpaceMcpExecutionWriteScope] as const;
const operationIdProperty = {
  type: 'string', minLength: 8, maxLength: 128, pattern: operationIdJsonPattern,
  description: 'Caller-supplied idempotency key for this exact Handoff operation.'
} as const;
const requestedPermissionsProperties = {
  delivery: { type: 'string', enum: ['none', 'pull_request'] },
  network: { type: 'string', enum: ['none', 'restricted', 'open'] },
  repository: { type: 'string', enum: ['read', 'write'] },
  task: { type: 'string', enum: ['read', 'write'] },
  workspace: { type: 'string', enum: ['read', 'write'] }
} as const;
const artifactOutputSchema = {
  type: 'object', required: [
    'authorization', 'content', 'digest', 'id', 'kind', 'mediaType', 'name',
    'provenance', 'sizeBytes', 'storage', 'verification'
  ], properties: {
    authorization: { type: 'object' }, content: { type: 'object' },
    digest: { type: 'string', pattern: digestJsonPattern }, id: { type: 'string' },
    kind: { type: 'string', enum: artifactKinds }, mediaType: { type: 'string' },
    name: { type: 'string' }, provenance: { type: 'object' }, sizeBytes: { type: 'integer' },
    storage: { type: 'object' }, verification: { type: 'object' }
  }
} as const;
const handoffResultSchema = {
  type: 'object', required: ['apiVersion', 'handoff', 'message'], properties: {
    apiVersion: { type: 'integer', enum: [1] },
    handoff: { type: 'object', required: [
      'acceptanceCriteria', 'artifacts', 'constraints', 'context', 'createdAt',
      'createdBy', 'decisions', 'handoffId', 'objective', 'requestedMode',
      'requestedPermissions', 'revision', 'taskId'
    ], properties: {
      artifacts: { type: 'array', items: artifactOutputSchema },
      requestedMode: { type: 'string', enum: modes },
      requestedPermissions: { type: 'object', properties: requestedPermissionsProperties }
    } },
    message: { type: 'string' }, operationId: { type: 'string' }, replayed: { type: 'boolean' }
  }
} as const;
const output = (result: object) => ({
  type: 'object' as const,
  required: ['result'],
  properties: { result }
});
const inlineArtifactJsonSchema = {
  type: 'object', required: [
    'digest', 'id', 'kind', 'mediaType', 'name', 'sizeBytes', 'source'
  ], additionalProperties: false, properties: {
    digest: { type: 'string', pattern: digestJsonPattern },
    id: { type: 'string', pattern: artifactIdJsonPattern },
    kind: { type: 'string', enum: artifactKinds },
    mediaType: { type: 'string', pattern: mediaTypeJsonPattern, maxLength: 128 },
    name: { type: 'string', minLength: 1, maxLength: 512 },
    sizeBytes: { type: 'integer', minimum: 0, maximum: 8_388_608 },
    source: { type: 'object', required: ['data', 'encoding', 'kind'], additionalProperties: false,
      properties: {
        data: { type: 'string' }, encoding: { type: 'string', enum: ['base64', 'utf8'] },
        kind: { type: 'string', enum: ['inline'] }
      } }
  }
} as const;
const existingArtifactJsonSchema = {
  type: 'object', required: ['id', 'source'], additionalProperties: false, properties: {
    id: { type: 'string', pattern: artifactIdJsonPattern },
    source: { type: 'object', required: ['artifactId', 'handoffId', 'kind', 'revision'],
      additionalProperties: false, properties: {
        artifactId: { type: 'string', pattern: artifactIdJsonPattern },
        handoffId: { type: 'string', format: 'uuid' },
        kind: { type: 'string', enum: ['handoff'] },
        revision: { type: 'integer', minimum: 1 }
      } }
  }
} as const;

export const taskHandoffTools = [
  defineOAuthTool('create_task_handoff', 'Create task handoff', 'Create a verified immutable Task Handoff revision. Artifact bytes are stored by Project Space; arbitrary URLs and target-machine paths are not accepted.', {
    type: 'object', required: [
      'objective', 'operationId', 'requestedMode', 'requestedPermissions', 'task'
    ], properties: {
      acceptanceCriteria: { type: 'array', maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 4_000 } },
      artifacts: { type: 'array', maxItems: 32, items: {
        oneOf: [inlineArtifactJsonSchema, existingArtifactJsonSchema]
      } },
      baseRevision: { type: 'integer', minimum: 1 },
      constraints: { type: 'array', maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 4_000 } },
      context: { type: 'string', maxLength: 60_000 },
      decisions: { type: 'array', maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 4_000 } },
      handoffId: { type: 'string', format: 'uuid' },
      objective: { type: 'string', minLength: 1, maxLength: 12_000 },
      operationId: operationIdProperty,
      requestedMode: { type: 'string', enum: modes },
      requestedPermissions: { type: 'object', required: [
        'delivery', 'network', 'repository', 'task', 'workspace'
      ], additionalProperties: false, properties: requestedPermissionsProperties },
      task: { type: 'object', required: ['number', 'provider', 'repositoryId'],
        additionalProperties: false, properties: {
          number: { type: 'integer', minimum: 1 },
          provider: { type: 'string', enum: ['github'] },
          repositoryId: { type: 'string', minLength: 1, maxLength: 512 }
        } }
    }, additionalProperties: false
  }, { destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: false },
  writeScopes, output(handoffResultSchema)),
  defineOAuthTool('get_task_handoff', 'Get task handoff', 'Read one exact immutable Task Handoff revision and its verified cross-machine artifact content.', {
    type: 'object', required: ['handoffId'], properties: {
      handoffId: { type: 'string', format: 'uuid' },
      revision: { type: 'integer', minimum: 1 }
    }, additionalProperties: false
  }, { destructiveHint: false, idempotentHint: true, openWorldHint: false, readOnlyHint: true },
  undefined, output(handoffResultSchema)),
  defineOAuthTool('update_task_execution_handoff', 'Update task execution handoff', 'Change a Task Execution to an exact Handoff revision only before an executor starts. The revision change is recorded in execution history.', {
    type: 'object', required: ['executionId', 'handoffId', 'operationId', 'revision'],
    properties: {
      executionId: { type: 'string', format: 'uuid' },
      handoffId: { type: 'string', format: 'uuid' },
      operationId: operationIdProperty,
      revision: { type: 'integer', minimum: 1 }
    }, additionalProperties: false
  }, { destructiveHint: false, idempotentHint: true, openWorldHint: false, readOnlyHint: false },
  updateScopes, output({
    type: 'object', required: ['apiVersion', 'execution', 'message', 'operationId', 'state'],
    properties: {
      apiVersion: { type: 'integer', enum: [1] }, execution: { type: 'object' },
      message: { type: 'string' }, operationId: { type: 'string' },
      replayed: { type: 'boolean' }, state: { type: 'string', enum: ['blocked', 'updated'] }
    }
  }))
];
