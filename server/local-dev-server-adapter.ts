import { resolve } from 'node:path';

import type { DevServerRuntimeResult } from '../src/shared/project-space-api';

import { runProjectBinary } from './local-project-cli-client';
import {
  connectorDevServerErrorResult,
  isConnectorDevServerResult,
  type ConnectorDevServerAdapter,
  type ConnectorDevServerExecutionRequest,
  type ConnectorDevServerOperation,
  type ConnectorDevServerResult
} from './connector-dev-server-contract';

type ProjectServeJson = DevServerRuntimeResult;

const serveResultKeys = [
  'allowedHosts',
  'capability',
  'checkedAt',
  'directory',
  'lastError',
  'localPort',
  'localUrl',
  'operation',
  'pid',
  'publicPort',
  'publicUrl',
  'schemaVersion',
  'script',
  'startedAt',
  'state',
  'tailscaleIPv4'
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNullablePort(value: unknown): value is number | null {
  return value === null || (Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 65_535);
}

function isProjectServeJson(value: unknown): value is ProjectServeJson {
  if (!isRecord(value)) {
    return false;
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== serveResultKeys.length ||
    !serveResultKeys.every((key, index) => key === keys[index])
  ) {
    return false;
  }
  return (
    value.schemaVersion === 1 &&
    (value.operation === 'start' || value.operation === 'status' || value.operation === 'stop') &&
    typeof value.script === 'string' &&
    typeof value.directory === 'string' &&
    (value.capability === 'configured' || value.capability === 'unavailable') &&
    (value.state === 'starting' ||
      value.state === 'running' ||
      value.state === 'stopping' ||
      value.state === 'stopped' ||
      value.state === 'error') &&
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

function expectedCliOperation(operation: ConnectorDevServerOperation) {
  return operation === 'inspect' ? 'status' : operation;
}

function commandArgs(request: ConnectorDevServerExecutionRequest) {
  if (request.operation === 'inspect') {
    return [
      'serve',
      'status',
      request.worktreePath,
      '--script',
      request.runTarget,
      '--json'
    ];
  }
  if (request.operation === 'stop') {
    return [
      'serve',
      'stop',
      request.worktreePath,
      '--script',
      request.runTarget,
      '--json'
    ];
  }
  return [
    'serve',
    request.runTarget,
    request.worktreePath,
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

export function createLocalDevServerAdapter(): ConnectorDevServerAdapter {
  return {
    async runDevServerCommand(request) {
      const result = await runProjectBinary(commandArgs(request), request.worktreePath);
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
        resolve(parsed.directory) !== resolve(request.worktreePath)
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
