import type { DatabaseQueryClient } from '../database/client';
import type { StoredWorkspaceCommand, WorkspaceCommandStore } from './contracts';

interface CommandRow {
  allow_network: boolean | null;
  audit_id: string;
  command_id: string;
  command_sha256: string;
  connector_generation: number | string | null;
  connector_id: string | null;
  created_at: Date | string;
  environment_id: string;
  expected_head_sha: string | null;
  execution_id: string | null;
  exit_code: number | null;
  finished_at: Date | string | null;
  max_output_bytes: number | string;
  output_cursor: number | string;
  owner_user_id: string;
  project_id: string | null;
  provider_kind: string | null;
  provider_resource_id: string | null;
  repository_writable: boolean | null;
  scope: StoredWorkspaceCommand['scope'];
  start_operation_fingerprint: string;
  start_operation_id: string;
  started_at: Date | string | null;
  state: StoredWorkspaceCommand['state'];
  stderr: string;
  stdout: string;
  target_reference: string | null;
  timeout_seconds: number | string;
  truncated: boolean;
  updated_at: Date | string;
  workspace_id: string | null;
  workspace_writable: boolean | null;
}

const columns = `
  id as command_id, audit_id, owner_user_id, scope, execution_id, environment_id,
  workspace_id, connector_id, connector_generation, project_id, target_reference,
  expected_head_sha, workspace_writable, allow_network,
  repository_writable, provider_kind, provider_resource_id,
  start_operation_id, start_operation_fingerprint,
  command_sha256, timeout_seconds, max_output_bytes,
  state, stdout, stderr, output_cursor, truncated, exit_code, started_at, finished_at,
  created_at, updated_at
`;

const terminal = new Set(['cancelled', 'completed', 'failed', 'unsupported']);

export class PostgresWorkspaceCommandStore implements WorkspaceCommandStore {
  constructor(private readonly client: DatabaseQueryClient) {}

  async create(command: StoredWorkspaceCommand) {
    assertCommand(command);
    const result = await this.client.query<{ id: string }>(
      `insert into workspace_commands (
         id, audit_id, owner_user_id, scope, execution_id, environment_id, workspace_id,
         connector_id, connector_generation, project_id, target_reference, expected_head_sha,
         workspace_writable, allow_network, repository_writable, provider_kind, provider_resource_id,
         start_operation_id, start_operation_fingerprint, command_sha256,
         timeout_seconds, max_output_bytes, state,
         stdout, stderr, output_cursor, truncated, exit_code, started_at, finished_at,
         created_at, updated_at
       ) values (
         $1::uuid, $2::uuid, $3, $4, $5::uuid, $6::uuid, $7::uuid, $8, $9, $10,
         $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25,
         $26, $27, $28, $29::timestamptz, $30::timestamptz, $31::timestamptz, $32::timestamptz
       ) on conflict do nothing returning id`, values(command)
    );
    if (result.rows[0]) return 'created' as const;
    const existing = await this.read(command.ownerUserId, command.commandId);
    return existing && sameIdentity(existing, command) ? 'replayed' as const : 'conflict' as const;
  }

  async read(ownerUserId: string, commandId: string) {
    const result = await this.client.query<CommandRow>(
      `select ${columns} from workspace_commands
        where owner_user_id = $1 and id = $2::uuid`, [ownerUserId, commandId]
    );
    return result.rows[0] ? mapCommand(result.rows[0]) : undefined;
  }

  async update(input: Parameters<WorkspaceCommandStore['update']>[0]) {
    const current = await this.read(input.ownerUserId, input.commandId);
    if (!current) return undefined;
    if (terminal.has(current.state)) return current;
    const result = await this.client.query<CommandRow>(
      `update workspace_commands set
         state = $3, stdout = coalesce($4, stdout), stderr = coalesce($5, stderr),
         truncated = coalesce($6, truncated), exit_code = coalesce($7, exit_code),
         started_at = coalesce(started_at, $8::timestamptz),
         finished_at = coalesce(finished_at, $9::timestamptz),
         output_cursor = output_cursor + case when
           stdout is distinct from coalesce($4, stdout) or
           stderr is distinct from coalesce($5, stderr) or
           truncated is distinct from coalesce($6, truncated)
           then 1 else 0 end,
         updated_at = $10::timestamptz
       where owner_user_id = $1 and id = $2::uuid
         and state not in ('cancelled', 'completed', 'failed', 'unsupported')
       returning ${columns}`,
      [
        input.ownerUserId, input.commandId, input.state, input.stdout ?? null,
        input.stderr ?? null, input.truncated ?? null, input.exitCode ?? null,
        input.startedAt ?? null, input.finishedAt ?? null, input.checkedAt
      ]
    );
    return result.rows[0] ? mapCommand(result.rows[0]) : this.read(input.ownerUserId, input.commandId);
  }
}

export class MemoryWorkspaceCommandStore implements WorkspaceCommandStore {
  private readonly commands = new Map<string, StoredWorkspaceCommand>();
  async create(command: StoredWorkspaceCommand) {
    assertCommand(command);
    const key = `${command.ownerUserId}\0${command.commandId}`;
    const current = this.commands.get(key);
    if (current) return sameIdentity(current, command) ? 'replayed' as const : 'conflict' as const;
    this.commands.set(key, structuredClone(command));
    return 'created' as const;
  }
  async read(ownerUserId: string, commandId: string) {
    const command = this.commands.get(`${ownerUserId}\0${commandId}`);
    return command ? structuredClone(command) : undefined;
  }
  async update(input: Parameters<WorkspaceCommandStore['update']>[0]) {
    const key = `${input.ownerUserId}\0${input.commandId}`;
    const current = this.commands.get(key);
    if (!current) return undefined;
    if (terminal.has(current.state)) return structuredClone(current);
    const outputChanged =
      (input.stdout !== undefined && input.stdout !== current.stdout) ||
      (input.stderr !== undefined && input.stderr !== current.stderr) ||
      (input.truncated !== undefined && input.truncated !== current.truncated);
    const updated: StoredWorkspaceCommand = {
      ...current, ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
      ...(input.finishedAt ? { finishedAt: input.finishedAt } : {}),
      ...(input.startedAt ? { startedAt: current.startedAt ?? input.startedAt } : {}),
      ...(input.stderr !== undefined ? { stderr: input.stderr } : {}),
      ...(input.stdout !== undefined ? { stdout: input.stdout } : {}),
      ...(input.truncated !== undefined ? { truncated: input.truncated } : {}),
      outputCursor: current.outputCursor + (outputChanged ? 1 : 0),
      state: input.state, updatedAt: input.checkedAt
    };
    this.commands.set(key, updated);
    return structuredClone(updated);
  }
}

function values(command: StoredWorkspaceCommand) {
  return [
    command.commandId, command.auditId, command.ownerUserId, command.scope,
    command.executionId ?? null, command.environmentId, command.workspaceId ?? null,
    command.connectorId ?? null, command.connectorGeneration ?? null, command.projectId ?? null,
    command.targetReference ?? null, command.expectedHeadSha ?? null,
    command.workspaceWritable ?? null, command.allowNetwork ?? null,
    command.repositoryWritable ?? null, command.providerKind ?? null,
    command.providerResourceId ?? null, command.startOperationId,
    command.startOperationFingerprint, command.commandSha256, command.timeoutSeconds,
    command.maxOutputBytes, command.state, command.stdout, command.stderr,
    command.outputCursor, command.truncated, command.exitCode ?? null,
    command.startedAt ?? null, command.finishedAt ?? null, command.createdAt, command.updatedAt
  ];
}

function mapCommand(row: CommandRow): StoredWorkspaceCommand {
  const base = {
    auditId: row.audit_id, commandId: row.command_id, commandSha256: row.command_sha256,
    createdAt: new Date(row.created_at).toISOString(), environmentId: row.environment_id,
    ...(row.exit_code !== null ? { exitCode: row.exit_code } : {}),
    ...(row.finished_at ? { finishedAt: new Date(row.finished_at).toISOString() } : {}),
    maxOutputBytes: Number(row.max_output_bytes), outputCursor: Number(row.output_cursor),
    ownerUserId: row.owner_user_id,
    startOperationFingerprint: row.start_operation_fingerprint,
    startOperationId: row.start_operation_id, ...(row.started_at ? {
      startedAt: new Date(row.started_at).toISOString()
    } : {}), state: row.state, stderr: row.stderr, stdout: row.stdout,
    timeoutSeconds: Number(row.timeout_seconds), truncated: row.truncated,
    updatedAt: new Date(row.updated_at).toISOString()
  };
  if (row.scope === 'workspace') return {
    ...base, allowNetwork: row.allow_network!, connectorGeneration: Number(row.connector_generation),
    connectorId: row.connector_id!, executionId: row.execution_id!,
    expectedHeadSha: row.expected_head_sha!, projectId: row.project_id!, scope: 'workspace',
    repositoryWritable: row.repository_writable!,
    targetReference: row.target_reference!, workspaceId: row.workspace_id!,
    workspaceWritable: row.workspace_writable!
  };
  return {
    ...base, providerKind: 'github_codespaces', providerResourceId: row.provider_resource_id!,
    scope: 'environment_recovery'
  };
}

function sameIdentity(left: StoredWorkspaceCommand, right: StoredWorkspaceCommand) {
  return left.auditId === right.auditId && left.commandSha256 === right.commandSha256 &&
    left.environmentId === right.environmentId && left.scope === right.scope &&
    left.executionId === right.executionId && left.workspaceId === right.workspaceId &&
    left.connectorId === right.connectorId && left.connectorGeneration === right.connectorGeneration &&
    left.targetReference === right.targetReference && left.expectedHeadSha === right.expectedHeadSha &&
    left.workspaceWritable === right.workspaceWritable && left.allowNetwork === right.allowNetwork &&
    left.repositoryWritable === right.repositoryWritable &&
    left.projectId === right.projectId && left.providerKind === right.providerKind &&
    left.providerResourceId === right.providerResourceId &&
    left.startOperationId === right.startOperationId &&
    left.startOperationFingerprint === right.startOperationFingerprint &&
    left.timeoutSeconds === right.timeoutSeconds && left.maxOutputBytes === right.maxOutputBytes;
}

function assertCommand(command: StoredWorkspaceCommand) {
  if (!/^[0-9a-f-]{36}$/i.test(command.commandId) || !/^[0-9a-f-]{36}$/i.test(command.auditId) ||
      !/^[0-9a-f]{64}$/.test(command.commandSha256) ||
      !/^[0-9a-f]{64}$/.test(command.startOperationFingerprint) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(command.startOperationId) ||
      !command.ownerUserId.trim() ||
      !Number.isFinite(Date.parse(command.createdAt)) || command.stdout || command.stderr ||
      command.outputCursor !== 0 || command.state !== 'queued')
    throw new Error('Workspace command is invalid.');
}
