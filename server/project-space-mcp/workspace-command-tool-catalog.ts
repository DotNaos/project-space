import { z } from 'zod';
import {
  projectSpaceMcpReadScope,
  projectSpaceMcpShellRecoveryScope,
  projectSpaceMcpShellWorkspaceScope,
  projectSpaceMcpWriteScope
} from '../project-space-mcp-oauth-store';
import { defineOAuthTool } from './tool-definition';

const uuid = z.string().uuid();
const operationId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/);
const limits = {
  maxOutputBytes: z.number().int().min(1_024).max(262_144).optional(),
  timeoutSeconds: z.number().int().min(1).max(900).optional()
};

export const workspaceCommandToolSchemas = {
  start_workspace_command: z.object({
    command: z.string().min(1).max(32_768),
    executionId: uuid,
    ...limits,
    operationId
  }).strict(),
  start_environment_recovery_command: z.object({
    command: z.string().min(1).max(32_768),
    environmentId: uuid,
    ...limits,
    operationId
  }).strict(),
  get_workspace_command: z.object({
    afterCursor: z.number().int().min(0).optional(),
    commandId: uuid
  }).strict(),
  cancel_workspace_command: z.object({
    commandId: uuid,
    operationId
  }).strict(),
  cancel_environment_recovery_command: z.object({
    commandId: uuid,
    operationId
  }).strict()
};

const workspaceScopes = [
  projectSpaceMcpReadScope,
  projectSpaceMcpWriteScope,
  projectSpaceMcpShellWorkspaceScope
] as const;
const recoveryScopes = [
  projectSpaceMcpReadScope,
  projectSpaceMcpWriteScope,
  projectSpaceMcpShellRecoveryScope
] as const;
const operationPattern = '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$';
const limitProperties = {
  maxOutputBytes: { type: 'integer', minimum: 1_024, maximum: 262_144 },
  timeoutSeconds: { type: 'integer', minimum: 1, maximum: 900 }
} as const;

export const workspaceCommandTools = [
  defineOAuthTool(
    'start_workspace_command', 'Start workspace command',
    'Run one asynchronous command in the exact stored runner workspace. The server selects the connector and directory and enforces the Handoff permissions.',
    {
      type: 'object', required: ['command', 'executionId', 'operationId'],
      properties: {
        command: { type: 'string', minLength: 1, maxLength: 32_768 },
        executionId: { type: 'string', format: 'uuid' }, ...limitProperties,
        operationId: { type: 'string', pattern: operationPattern }
      }, additionalProperties: false
    },
    { destructiveHint: true, idempotentHint: true, openWorldHint: true, readOnlyHint: false },
    workspaceScopes
  ),
  defineOAuthTool(
    'get_workspace_command', 'Get workspace command',
    'Read and reconcile an asynchronous workspace or recovery command with bounded cursor-based output.',
    {
      type: 'object', required: ['commandId'], properties: {
        afterCursor: { type: 'integer', minimum: 0 },
        commandId: { type: 'string', format: 'uuid' }
      }, additionalProperties: false
    },
    { destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: true },
    [projectSpaceMcpReadScope]
  ),
  defineOAuthTool(
    'cancel_workspace_command', 'Cancel workspace command',
    'Cancel the exact asynchronous command process. An uncertain cancellation is never reported as confirmed.',
    {
      type: 'object', required: ['commandId', 'operationId'], properties: {
        commandId: { type: 'string', format: 'uuid' },
        operationId: { type: 'string', pattern: operationPattern }
      }, additionalProperties: false
    },
    { destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: false },
    workspaceScopes
  ),
  defineOAuthTool(
    'start_environment_recovery_command', 'Start approved Codespace recovery command',
    'Ask the user to approve, then run one remote recovery command in an exact live GitHub Codespace. This never falls back to the Project Space server.',
    {
      type: 'object', required: ['command', 'environmentId', 'operationId'],
      properties: {
        command: { type: 'string', minLength: 1, maxLength: 32_768 },
        environmentId: { type: 'string', format: 'uuid' }, ...limitProperties,
        operationId: { type: 'string', pattern: operationPattern }
      }, additionalProperties: false
    },
    { destructiveHint: true, idempotentHint: true, openWorldHint: true, readOnlyHint: false },
    recoveryScopes
  ),
  defineOAuthTool(
    'cancel_environment_recovery_command', 'Cancel Codespace recovery command',
    'Cancel the exact approved remote recovery process. An uncertain cancellation is never reported as confirmed.',
    {
      type: 'object', required: ['commandId', 'operationId'], properties: {
        commandId: { type: 'string', format: 'uuid' },
        operationId: { type: 'string', pattern: operationPattern }
      }, additionalProperties: false
    },
    { destructiveHint: false, idempotentHint: true, openWorldHint: true, readOnlyHint: false },
    recoveryScopes
  )
] as const;
