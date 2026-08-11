import { resolve } from 'node:path';

import type {
  DevServerRuntimeListResult,
  DevServerRuntimeResult
} from '../src/shared/project-space-api';

import { runProjectBinary } from './local-project-cli-client';
import { resolveLocalProjectPath } from './local-project-identity';
import { resolveLocalProjectWorktree } from './local-project-worktrees';
import {
  connectorDevServerErrorResult,
  connectorDevServerListErrorResult,
  isConnectorDevServerListResult,
  isConnectorDevServerResult,
  type ConnectorDevServerAdapter,
  type ConnectorDevServerExecutionRequest,
  type ConnectorDevServerListExecutionRequest,
  type ConnectorDevServerListResult,
  type ConnectorDevServerOperation,
  type ConnectorDevServerResult
} from './connector-dev-server-contract';

type ProjectServeJson = DevServerRuntimeResult;
type ProjectServeListJson = DevServerRuntimeListResult;

const serveResultKeys = [
  'allowedHosts',
  'capability',
  'checkedAt',
  'directory',
  'lastError',
  'localPort',
  'localUrl',
  'mode',
  'operation',
  'pid',
  'portlessName',
  'publicPort',
  'publicUrl',
  'repository',
  'schemaVersion',
  'script',
  'serverId',
  'serverKey',
  'startedAt',
  'state',
  'tailscaleIPv4',
  'tmuxSession'
] as const;

const optionalServeResultKeys = ['disposition'] as const;

const serveListResultKeys = [
  'capability',
  'checkedAt',
  'directory',
  'lastError',
  'operation',
  'schemaVersion',
  'servers'
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNullablePort(value: unknown): value is number | null {
  return (
    value === null || (Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 65_535)
  );
}

function isProjectServeJson(value: unknown): value is ProjectServeJson {
  if (!isRecord(value)) {
    return false;
  }
  const keys = Object.keys(value).filter(
    (key) => !optionalServeResultKeys.includes(key as (typeof optionalServeResultKeys)[number])
  ).sort();
  if (
    keys.length !== serveResultKeys.length ||
    !serveResultKeys.every((key, index) => key === keys[index])
  ) {
    return false;
  }
  return (
    value.schemaVersion === 2 &&
    (value.operation === 'start' || value.operation === 'status' || value.operation === 'stop') &&
    typeof value.script === 'string' &&
    typeof value.directory === 'string' &&
    (value.mode === 'managed' || value.mode === 'local-only') &&
    typeof value.serverId === 'string' &&
    typeof value.serverKey === 'string' &&
    value.serverKey === value.script &&
    typeof value.repository === 'string' &&
    typeof value.tmuxSession === 'string' &&
    typeof value.portlessName === 'string' &&
    (value.disposition === undefined || value.disposition === 'created' || value.disposition === 'reused') &&
    (value.capability === 'configured' || value.capability === 'unavailable') &&
    (value.state === 'starting' ||
      value.state === 'running' ||
      value.state === 'local-only' ||
      value.state === 'stopping' ||
      value.state === 'stopped' ||
      value.state === 'failed' ||
      value.state === 'stale') &&
    (value.pid === null || (Number.isInteger(value.pid) && Number(value.pid) > 0)) &&
    isNullablePort(value.localPort) &&
    isNullableString(value.localUrl) &&
    isNullablePort(value.publicPort) &&
    isNullableString(value.publicUrl) &&
    isNullableString(value.tailscaleIPv4) &&
    Array.isArray(value.allowedHosts) &&
    value.allowedHosts.every((host) => typeof host === 'string') &&
    isNullableString(value.startedAt) &&
    typeof value.checkedAt === 'string' &&
    isNullableString(value.lastError)
  );
}

function isProjectServeListJson(value: unknown): value is ProjectServeListJson {
  if (!isRecord(value)) {
    return false;
  }
  const keys = Object.keys(value).sort();
  return (
    keys.length === serveListResultKeys.length &&
    serveListResultKeys.every((key, index) => key === keys[index]) &&
    value.schemaVersion === 2 &&
    value.operation === 'list' &&
    typeof value.directory === 'string' &&
    (value.capability === 'configured' || value.capability === 'unavailable') &&
    Array.isArray(value.servers) &&
    value.servers.length <= 64 &&
    value.servers.every(
      (server) =>
        isRecord(server) &&
        (server.capability === 'configured' || server.capability === 'unavailable') &&
        typeof server.label === 'string' &&
        typeof server.serverId === 'string'
    ) &&
    typeof value.checkedAt === 'string' &&
    isNullableString(value.lastError)
  );
}

function expectedCliOperation(operation: ConnectorDevServerOperation) {
  return operation === 'inspect' ? 'status' : operation;
}

function commandArgs(request: ConnectorDevServerExecutionRequest, worktreePath: string) {
  if (request.operation === 'inspect') {
    return ['serve', 'status', worktreePath, '--script', request.runTarget, '--json'];
  }
  if (request.operation === 'stop') {
    return ['serve', 'stop', worktreePath, '--script', request.runTarget, '--json'];
  }
  return [
    'serve',
    request.runTarget,
    worktreePath,
    '--json',
    ...request.allowedHosts.flatMap((host) => ['--allowed-host', host])
  ];
}

function safeCommandError(stderr: string, fallback: string) {
  const message = stderr.trim();
  return (message || fallback).slice(0, 2_000);
}

function mapServeResult(
  raw: ProjectServeJson,
  request: ConnectorDevServerExecutionRequest
): ConnectorDevServerResult {
  const mapped: ConnectorDevServerResult = {
    capability: raw.capability,
    checkedAt: raw.checkedAt,
    generation: request.actor.generation,
    machineId: request.machineId,
    projectId: request.projectId,
    runTarget: request.runTarget,
    serverId: request.serverId,
    state: raw.state,
    worktreeId: request.worktreeId,
    ...(raw.lastError ? { lastError: raw.lastError } : {}),
    ...(raw.localPort ? { localPort: raw.localPort } : {}),
    ...(raw.localUrl ? { localUrl: raw.localUrl } : {}),
    ...(raw.publicPort ? { publicPort: raw.publicPort } : {}),
    ...(raw.startedAt ? { startedAt: raw.startedAt } : {}),
    ...(raw.tailscaleIPv4 ? { tailscaleIPv4: raw.tailscaleIPv4 } : {}),
    ...(raw.publicUrl ? { tailscaleUrl: raw.publicUrl } : {})
  };
  if (!isConnectorDevServerResult(mapped)) {
    throw new Error('Project CLI returned an invalid dev-server state.');
  }
  return mapped;
}

export function createLocalDevServerAdapter(
  options: {
    resolveProjectPath?: typeof resolveLocalProjectPath;
    resolveWorktree?: typeof resolveLocalProjectWorktree;
    runBinary?: typeof runProjectBinary;
  } = {}
): ConnectorDevServerAdapter {
  const projectPathResolver = options.resolveProjectPath ?? resolveLocalProjectPath;
  const worktreeResolver = options.resolveWorktree ?? resolveLocalProjectWorktree;
  const runBinary = options.runBinary ?? runProjectBinary;

  async function resolvedWorktreePath(request: {
    expectedHeadSha: string;
    machineId: string;
    projectId: string;
    worktreeId: string;
  }) {
    const projectPath = await projectPathResolver(request.machineId, request.projectId);
    const worktree = await worktreeResolver(projectPath, request.worktreeId, {
      expectedHeadSha: request.expectedHeadSha
    });
    return worktree.path;
  }

  return {
    async listDevServers(request: ConnectorDevServerListExecutionRequest) {
      const worktreePath = await resolvedWorktreePath(request);
      const result = await runBinary(
        ['serve', 'list', worktreePath, '--configured', '--format', 'json'],
        worktreePath
      );
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.stdout.trim()) as unknown;
      } catch {
        return connectorDevServerListErrorResult(request, request.actor.generation);
      }
      if (!isProjectServeListJson(parsed) || resolve(parsed.directory) !== resolve(worktreePath)) {
        return connectorDevServerListErrorResult(request, request.actor.generation);
      }
      const mapped: ConnectorDevServerListResult = {
        capability: parsed.capability,
        checkedAt: parsed.checkedAt,
        generation: request.actor.generation,
        ...(parsed.lastError ? { lastError: parsed.lastError.slice(0, 500) } : {}),
        machineId: request.machineId,
        projectId: request.projectId,
        servers: parsed.servers,
        worktreeId: request.worktreeId
      };
      return isConnectorDevServerListResult(mapped)
        ? mapped
        : connectorDevServerListErrorResult(request, request.actor.generation);
    },
    async runDevServerCommand(request) {
      const worktreePath = await resolvedWorktreePath(request);
      const result = await runBinary(commandArgs(request, worktreePath), worktreePath);
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.stdout.trim()) as unknown;
      } catch {
        return connectorDevServerErrorResult(
          request,
          request.actor.generation,
          safeCommandError(result.stderr, 'Project CLI did not return dev-server JSON.'),
          /(?:ENOENT|not found)/i.test(result.stderr) ? 'unavailable' : 'configured'
        );
      }

      if (!isProjectServeJson(parsed)) {
        return connectorDevServerErrorResult(
          request,
          request.actor.generation,
          'Project CLI returned a malformed dev-server response.'
        );
      }
      if (
        parsed.operation !== expectedCliOperation(request.operation) ||
        parsed.script !== request.runTarget ||
        resolve(parsed.directory) !== resolve(worktreePath)
      ) {
        return connectorDevServerErrorResult(
          request,
          request.actor.generation,
          'Project CLI returned dev-server state for a different target.'
        );
      }
      if (
        request.operation === 'start' &&
        (parsed.allowedHosts.length !== request.allowedHosts.length ||
          parsed.allowedHosts.some((host, index) => host !== request.allowedHosts[index]))
      ) {
        return connectorDevServerErrorResult(
          request,
          request.actor.generation,
          'Project CLI did not apply the requested allowed hosts.'
        );
      }

      try {
        return mapServeResult(parsed, request);
      } catch (error) {
        return connectorDevServerErrorResult(
          request,
          request.actor.generation,
          error instanceof Error ? error.message : 'Could not read Project CLI dev-server state.'
        );
      }
    }
  };
}
