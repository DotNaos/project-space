import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import {
  projectSpaceMcpReadScope,
  projectSpaceMcpWriteScope
} from '../project-space-mcp-oauth-store';

type OAuthTool = Tool & {
  securitySchemes: Array<{ scopes: string[]; type: 'oauth2' }>;
};

const environmentKinds = [
  'native_macos', 'native_windows', 'native_linux', 'wsl', 'docker', 'devbox',
  'github_codespace', 'cloud_sandbox', 'kubernetes_workload', 'virtual_machine',
  'other'
] as const;

const selectorFields = {
  connectorId: z.string().trim().min(1).optional(),
  environmentId: z.string().trim().min(1).optional(),
  physicalMachineId: z.string().trim().min(1).optional(),
  physicalMachineName: z.string().trim().min(1).optional()
};

function selectorSchema<Shape extends z.ZodRawShape>(shape: Shape) {
  return z.object({ ...selectorFields, ...shape }).superRefine((value, context) => {
    const selection = value as {
      environmentId?: unknown;
      physicalMachineId?: unknown;
      physicalMachineName?: unknown;
    };
    const physicalSelectors = [selection.physicalMachineId, selection.physicalMachineName]
      .filter(Boolean);
    if (selection.environmentId && physicalSelectors.length > 0) {
      context.addIssue({
        code: 'custom',
        message: 'Select one Environment or one deprecated physical-machine selector.'
      });
    }
  });
}

export const toolSchemas = {
  list_projects: z.object({ search: z.string().trim().max(200).optional() }),
  list_tasks: z.object({
    limit: z.number().int().min(1).max(100).optional(),
    repositoryId: z.string().trim().min(1),
    search: z.string().trim().max(200).optional(),
    state: z.enum(['open', 'closed', 'all']).optional()
  }),
  get_task: z.object({
    repositoryId: z.string().trim().min(1),
    task: z.number().int().positive()
  }),
  get_task_status: z.object({
    repositoryId: z.string().trim().min(1),
    task: z.number().int().positive()
  }),
  create_task: z.object({
    body: z.string().trim().max(100_000).optional(),
    labels: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
    operationId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
    repositoryId: z.string().trim().min(1),
    title: z.string().trim().min(1).max(1_000)
  }),
  update_task: z.object({
    body: z.string().trim().max(100_000).optional(),
    labels: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
    repositoryId: z.string().trim().min(1),
    state: z.enum(['open', 'closed']).optional(),
    task: z.number().int().positive(),
    title: z.string().trim().min(1).max(1_000).optional()
  }),
  list_task_comments: z.object({
    repositoryId: z.string().trim().min(1),
    task: z.number().int().positive()
  }),
  add_task_comment: z.object({
    body: z.string().trim().min(1).max(100_000),
    repositoryId: z.string().trim().min(1),
    task: z.number().int().positive()
  }),
  list_execution_environments: z.object({
    capability: z.string().trim().min(1).max(200).optional(),
    kind: z.enum(environmentKinds).optional(),
    platform: z.string().trim().min(1).max(200).optional()
  }),
  get_execution_environment: z.object({
    environmentId: z.string().trim().min(1).max(512)
  }),
  list_machines: z.object({}),
  list_codex_tasks: z.object({
    connectorId: z.string().trim().min(1).optional(),
    includeArchived: z.boolean().optional(),
    search: z.string().trim().max(200).optional()
  }),
  read_codex_task: selectorSchema({
    last: z.number().int().min(1).max(100).optional(),
    threadId: z.string().uuid()
  }),
  start_codex_task: selectorSchema({
    dryRun: z.boolean().optional(),
    operationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/).optional(),
    repositoryId: z.string().trim().min(1),
    task: z.number().int().positive()
  }),
  send_codex_message: selectorSchema({
    last: z.number().int().min(1).max(100).optional(),
    message: z.string().trim().min(1).max(100_000),
    operationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/).optional(),
    threadId: z.string().uuid(),
    wait: z.boolean().optional()
  })
};

const selectorProperties = {
  connectorId: { type: 'string', description: 'Exact connector association when one Environment has multiple channels.' },
  environmentId: { type: 'string', description: 'Canonical execution Environment id.' },
  physicalMachineId: { type: 'string', description: 'Deprecated physical-machine compatibility selector.' },
  physicalMachineName: { type: 'string', description: 'Deprecated physical-machine compatibility selector.' }
} as const;

const selectorConstraints = {
  allOf: [
    { not: { required: ['environmentId', 'physicalMachineId'] } },
    { not: { required: ['environmentId', 'physicalMachineName'] } }
  ]
} as const;

export const tools: OAuthTool[] = [
  tool('list_projects', 'List projects', 'List the Project Space projects and GitHub repositories available to the signed-in user.', {
    type: 'object', properties: { search: { type: 'string', description: 'Optional case-insensitive name filter.' } }, additionalProperties: false
  }, { readOnlyHint: true, openWorldHint: false }),
  tool('list_tasks', 'List tasks', 'List GitHub tasks in an authorized repository. Use list_projects first to select the repository.', {
    type: 'object', required: ['repositoryId'], properties: {
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      repositoryId: { type: 'string', description: 'Repository id or full name, for example DotNaos/project-space.' },
      search: { type: 'string', description: 'Optional case-insensitive search across task title, body, and labels.' },
      state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Defaults to open.' }
    }, additionalProperties: false
  }, { readOnlyHint: true, openWorldHint: true }),
  tool('get_task', 'Get task', 'Read one GitHub task from an authorized repository.', {
    type: 'object', required: ['repositoryId', 'task'], properties: {
      repositoryId: { type: 'string', description: 'Repository id or full name.' },
      task: { type: 'integer', minimum: 1, description: 'GitHub task number.' }
    }, additionalProperties: false
  }, { readOnlyHint: true, openWorldHint: true }),
  tool('get_task_status', 'Get task status', 'Read the linked GitHub branches, pull requests, and workflow runs for a task.', {
    type: 'object', required: ['repositoryId', 'task'], properties: {
      repositoryId: { type: 'string', description: 'Repository id or full name.' },
      task: { type: 'integer', minimum: 1, description: 'GitHub task number.' }
    }, additionalProperties: false
  }, { readOnlyHint: true, openWorldHint: true }),
  tool('create_task', 'Create task', 'Create a GitHub task in an authorized repository. Reuse operationId only for the same task draft.', {
    type: 'object', required: ['operationId', 'repositoryId', 'title'], properties: {
      body: { type: 'string' }, labels: { type: 'array', items: { type: 'string' }, maxItems: 50 },
      operationId: { type: 'string', format: 'uuid', description: 'Idempotency key. Reuse it only for the same task draft.' },
      repositoryId: { type: 'string', description: 'Repository id or full name.' }, title: { type: 'string', description: 'Task title.' }
    }, additionalProperties: false
  }, { destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: false }),
  tool('update_task', 'Update task', 'Update the title, body, labels, or open/closed state of a GitHub task.', {
    type: 'object', required: ['repositoryId', 'task'], properties: {
      body: { type: 'string' }, labels: { type: 'array', items: { type: 'string' }, maxItems: 50 },
      repositoryId: { type: 'string', description: 'Repository id or full name.' }, state: { type: 'string', enum: ['open', 'closed'] },
      task: { type: 'integer', minimum: 1, description: 'GitHub task number.' }, title: { type: 'string' }
    }, additionalProperties: false
  }, { destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: false }),
  tool('list_task_comments', 'List task comments', 'Read comments on one GitHub task.', {
    type: 'object', required: ['repositoryId', 'task'], properties: {
      repositoryId: { type: 'string', description: 'Repository id or full name.' }, task: { type: 'integer', minimum: 1, description: 'GitHub task number.' }
    }, additionalProperties: false
  }, { readOnlyHint: true, openWorldHint: true }),
  tool('add_task_comment', 'Add task comment', 'Add a comment to a GitHub task.', {
    type: 'object', required: ['body', 'repositoryId', 'task'], properties: {
      body: { type: 'string' }, repositoryId: { type: 'string', description: 'Repository id or full name.' },
      task: { type: 'integer', minimum: 1, description: 'GitHub task number.' }
    }, additionalProperties: false
  }, { destructiveHint: false, idempotentHint: false, openWorldHint: true, readOnlyHint: false }),
  tool('list_execution_environments', 'List execution environments', 'List canonical Project Space execution Environments with their optional Host, connector associations, and honest readiness evidence.', {
    type: 'object', properties: {
      capability: { type: 'string', description: 'Require a live connector capability.' },
      kind: { type: 'string', enum: environmentKinds },
      platform: { type: 'string', description: 'Platform id or provider kind.' }
    }, additionalProperties: false
  }, { readOnlyHint: true, openWorldHint: false }),
  tool('get_execution_environment', 'Get execution environment', 'Read one exact canonical execution Environment by environmentId.', {
    type: 'object', required: ['environmentId'], properties: {
      environmentId: { type: 'string', description: 'Canonical execution Environment id.' }
    }, additionalProperties: false
  }, { readOnlyHint: true, openWorldHint: false }),
  tool('list_machines', 'List machines', 'List the legacy connector-machine projection. Prefer list_execution_environments for new workflows.', {
    type: 'object', properties: {}, additionalProperties: false
  }, { readOnlyHint: true, openWorldHint: false }),
  tool('list_codex_tasks', 'List Codex tasks', 'List Codex tasks on one or all available connector machines.', {
    type: 'object', properties: { connectorId: { type: 'string' }, includeArchived: { type: 'boolean' }, search: { type: 'string' } }, additionalProperties: false
  }, { readOnlyHint: true, openWorldHint: false }),
  tool('read_codex_task', 'Read Codex task', 'Read the latest conversation turns from a Codex task.', {
    type: 'object', required: ['threadId'], properties: {
      ...selectorProperties, last: { type: 'integer', minimum: 1, maximum: 100 }, threadId: { type: 'string', format: 'uuid' }
    }, ...selectorConstraints, additionalProperties: false
  }, { readOnlyHint: true, openWorldHint: false }),
  tool('start_codex_task', 'Start Codex task', 'Start a Codex task from a GitHub task in one exact execution Environment.', {
    type: 'object', required: ['repositoryId', 'task'], properties: {
      ...selectorProperties, dryRun: { type: 'boolean', description: 'Validate and resolve the target without starting Codex.' },
      operationId: { type: 'string' }, repositoryId: { type: 'string' }, task: { type: 'integer', minimum: 1, description: 'GitHub task number.' }
    }, ...selectorConstraints, additionalProperties: false
  }, { destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: false }),
  tool('send_codex_message', 'Send Codex message', 'Send a follow-up message to an existing Codex task in one exact execution Environment.', {
    type: 'object', required: ['message', 'threadId'], properties: {
      ...selectorProperties, last: { type: 'integer', minimum: 1, maximum: 100 }, message: { type: 'string' },
      operationId: { type: 'string' }, threadId: { type: 'string', format: 'uuid' }, wait: { type: 'boolean' }
    }, ...selectorConstraints, additionalProperties: false
  }, { destructiveHint: false, idempotentHint: true, openWorldHint: false, readOnlyHint: false })
];

export function scopesForTool(name: string) {
  return ['start_codex_task', 'send_codex_message', 'create_task', 'update_task', 'add_task_comment'].includes(name)
    ? [projectSpaceMcpReadScope, projectSpaceMcpWriteScope]
    : [projectSpaceMcpReadScope];
}

function tool(
  name: string,
  title: string,
  description: string,
  inputSchema: Tool['inputSchema'],
  annotations: NonNullable<Tool['annotations']>
): OAuthTool {
  const scopes = annotations.readOnlyHint
    ? [projectSpaceMcpReadScope]
    : [projectSpaceMcpReadScope, projectSpaceMcpWriteScope];
  const securitySchemes = [{ type: 'oauth2' as const, scopes }];
  return {
    name, title, description, inputSchema, annotations, securitySchemes,
    _meta: { securitySchemes }
  } as OAuthTool;
}
