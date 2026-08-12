import {
  projectHostdPartialMetrics,
  projectHostdProtocolVersion,
  projectHostdSchemaVersion,
  type ProjectHostdCredentialRequest,
  type ProjectHostdObservation,
  type ProjectHostdResources,
  type ProjectHostdRuntimeTelemetry
} from '../../src/shared/project-hostd-api';
import type { IssueProjectHostdCredentialInput } from './contracts';
import { ProjectHostdError } from './contracts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const operationId = /^[A-Za-z0-9:._-]{1,256}$/;
const observationId = /^[A-Za-z0-9:._-]{1,128}$/;
const version = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/;
const partialMetricSet = new Set<string>(projectHostdPartialMetrics);

export function validateCredentialIssue(input: IssueProjectHostdCredentialInput) {
  const expiresInSeconds = input.expiresInSeconds ?? 30 * 24 * 60 * 60;
  if (!safeOwner(input.ownerUserId) || !uuid.test(input.deviceId) ||
    !uuid.test(input.environmentId) || input.hostId !== undefined && !uuid.test(input.hostId) ||
    !operationId.test(input.operationId) || !Number.isSafeInteger(expiresInSeconds) ||
    expiresInSeconds < 60 || expiresInSeconds > 90 * 24 * 60 * 60) invalid();
  return expiresInSeconds;
}

export function parseCredentialRequest(value: unknown): ProjectHostdCredentialRequest {
  const input = object(value);
  exactKeys(input, ['deviceId', 'environmentId', 'expiresInSeconds', 'hostId', 'operationId'], [
    'expiresInSeconds', 'hostId'
  ]);
  const request = {
    deviceId: string(input.deviceId),
    environmentId: string(input.environmentId),
    ...(input.expiresInSeconds === undefined ? {} : { expiresInSeconds: number(input.expiresInSeconds) }),
    ...(input.hostId === undefined ? {} : { hostId: string(input.hostId) }),
    operationId: string(input.operationId)
  };
  validateCredentialIssue({ ...request, ownerUserId: 'validated-owner' });
  return request;
}

export function parseObservation(value: unknown): ProjectHostdObservation {
  const input = object(value);
  exactKeys(input, [
    'deviceId', 'environmentId', 'health', 'hostId', 'hostdVersion', 'observationId',
    'observedAt', 'partialMetrics', 'protocolVersion', 'resources', 'runtimes',
    'schemaVersion', 'sequence', 'type', 'uptimeSeconds'
  ], ['hostId']);
  if (input.type !== 'hostd.telemetry' || input.schemaVersion !== projectHostdSchemaVersion ||
    input.protocolVersion !== projectHostdProtocolVersion || !uuid.test(string(input.deviceId)) ||
    !uuid.test(string(input.environmentId)) || input.hostId !== undefined && !uuid.test(string(input.hostId)) ||
    !version.test(string(input.hostdVersion)) || !observationId.test(string(input.observationId)) ||
    !validTime(input.observedAt) || !['healthy', 'degraded'].includes(string(input.health)) ||
    !Number.isSafeInteger(input.sequence) || number(input.sequence) < 1 ||
    !Number.isSafeInteger(input.uptimeSeconds) || number(input.uptimeSeconds) < 0) invalid();
  const partialMetrics = uniqueStrings(input.partialMetrics, partialMetricSet, 5);
  if (partialMetrics.length > 0 && input.health !== 'degraded') invalid();
  const runtimes = array(input.runtimes, 128).map(parseRuntime);
  const runtimeKeys = new Set(runtimes.map((runtime) => `${runtime.workspaceId}\0${runtime.generation}`));
  if (runtimeKeys.size !== runtimes.length) invalid();
  return {
    deviceId: string(input.deviceId), environmentId: string(input.environmentId),
    health: input.health as ProjectHostdObservation['health'],
    ...(input.hostId === undefined ? {} : { hostId: string(input.hostId) }),
    hostdVersion: string(input.hostdVersion), observationId: string(input.observationId),
    observedAt: string(input.observedAt), partialMetrics,
    protocolVersion: projectHostdProtocolVersion, resources: parseResources(input.resources),
    runtimes, schemaVersion: projectHostdSchemaVersion, sequence: number(input.sequence),
    type: 'hostd.telemetry', uptimeSeconds: number(input.uptimeSeconds)
  };
}

function parseResources(value: unknown): ProjectHostdResources {
  const input = object(value);
  exactKeys(input, ['architecture', 'cpu', 'gpu', 'memory', 'operatingSystem', 'storage'], ['gpu']);
  const cpu = object(input.cpu);
  exactKeys(cpu, ['cores', 'usedPercent']);
  const memory = object(input.memory);
  exactKeys(memory, ['availableBytes', 'totalBytes']);
  const storage = object(input.storage);
  exactKeys(storage, ['availableBytes', 'totalBytes']);
  const cores = number(cpu.cores);
  const cpuUsed = number(cpu.usedPercent);
  const memoryTotal = integer(memory.totalBytes);
  const memoryAvailable = integer(memory.availableBytes);
  const storageTotal = integer(storage.totalBytes);
  const storageAvailable = integer(storage.availableBytes);
  if (cores <= 0 || cores > 4096 || cpuUsed < 0 || cpuUsed > 100 ||
    memoryTotal <= 0 || memoryAvailable > memoryTotal ||
    storageTotal <= 0 || storageAvailable > storageTotal) invalid();
  const gpu = input.gpu === undefined ? undefined : array(input.gpu, 32).map((entry) => {
    const item = object(entry);
    exactKeys(item, ['memoryBytes', 'model', 'usedPercent'], ['memoryBytes', 'usedPercent']);
    const memoryBytes = item.memoryBytes === undefined ? undefined : integer(item.memoryBytes);
    const usedPercent = item.usedPercent === undefined ? undefined : number(item.usedPercent);
    if (memoryBytes !== undefined && memoryBytes < 0 ||
      usedPercent !== undefined && (usedPercent < 0 || usedPercent > 100)) invalid();
    return {
      ...(memoryBytes === undefined ? {} : { memoryBytes }),
      model: safeText(item.model, 128),
      ...(usedPercent === undefined ? {} : { usedPercent })
    };
  });
  return {
    architecture: safeText(input.architecture, 64),
    cpu: { cores, usedPercent: cpuUsed },
    ...(gpu === undefined ? {} : { gpu }),
    memory: { availableBytes: memoryAvailable, totalBytes: memoryTotal },
    operatingSystem: safeText(input.operatingSystem, 128),
    storage: { availableBytes: storageAvailable, totalBytes: storageTotal }
  };
}

function parseRuntime(value: unknown): ProjectHostdRuntimeTelemetry {
  const input = object(value);
  exactKeys(input, ['boundaryKind', 'cpuPercent', 'generation', 'memoryBytes', 'workspaceId']);
  const cpuPercent = number(input.cpuPercent);
  const memoryBytes = integer(input.memoryBytes);
  if (input.boundaryKind !== 'process_group' || cpuPercent < 0 || cpuPercent > 100 ||
    memoryBytes < 0 || !uuid.test(string(input.generation)) || !uuid.test(string(input.workspaceId))) invalid();
  return {
    boundaryKind: 'process_group', cpuPercent, generation: string(input.generation),
    memoryBytes, workspaceId: string(input.workspaceId)
  };
}

function uniqueStrings(value: unknown, allowed: ReadonlySet<string>, limit: number) {
  const values = array(value, limit).map(string);
  if (new Set(values).size !== values.length || values.some((entry) => !allowed.has(entry))) invalid();
  return values as ProjectHostdObservation['partialMetrics'];
}

function safeOwner(value: string) {
  return value.trim().length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}

function safeText(value: unknown, maximum: number) {
  const text = string(value);
  if (!text.trim() || text.length > maximum || /[\u0000-\u001f\u007f]/.test(text)) invalid();
  return text;
}

function validTime(value: unknown) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function exactKeys(value: Record<string, unknown>, allowed: string[], optional: string[] = []) {
  const actual = Object.keys(value);
  if (actual.some((key) => !allowed.includes(key)) ||
    allowed.some((key) => !optional.includes(key) && !actual.includes(key))) invalid();
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function array(value: unknown, maximum: number) {
  if (!Array.isArray(value) || value.length > maximum) invalid();
  return value;
}

function string(value: unknown) {
  if (typeof value !== 'string') invalid();
  return value;
}

function number(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid();
  return value;
}

function integer(value: unknown) {
  const result = number(value);
  if (!Number.isSafeInteger(result) || result < 0) invalid();
  return result;
}

function invalid(): never {
  throw new ProjectHostdError('invalid_message', 'project-hostd message is invalid.');
}
