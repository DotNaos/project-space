import {
  workspaceRuntimeCapabilities,
  workspaceRuntimeSessionSchemaVersion,
  type WorkspaceRuntimeCapability,
  type WorkspaceRuntimeCredentialRequest,
  type WorkspaceRuntimeDevServer,
  type WorkspaceRuntimeEvent,
  type WorkspaceRuntimeRegistration
} from '../../src/shared/workspace-runtime-session-api';
import type { IssueRuntimeCredentialInput } from './contracts';
import { RuntimeSessionError } from './contracts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const workspace = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const commit = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const eventId = /^[A-Za-z0-9:._-]{1,128}$/;
const capabilitySet = new Set<string>(workspaceRuntimeCapabilities);

export function validateCredentialIssue(input: IssueRuntimeCredentialInput) {
  const expiresInSeconds = input.expiresInSeconds ?? 300;
  if (!input.ownerUserId.trim() || input.ownerUserId.length > 256 ||
    !workspace.test(input.workspaceId) || !uuid.test(input.environmentId) || !uuid.test(input.generation) ||
    !commit.test(input.commit) || !digest.test(input.manifestDigest) ||
    !Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 30 || expiresInSeconds > 3_600) invalid();
  safeText(input.branch, 256);
  safeText(input.runtimeVersion, 64);
  parseCapabilities(input.capabilities);
  return expiresInSeconds;
}

export function parseCredentialRequest(value: unknown): WorkspaceRuntimeCredentialRequest {
  const input = object(value);
  exactKeys(input, ['capabilities', 'environmentId', 'expiresInSeconds', 'generation', 'workspaceId'], ['expiresInSeconds']);
  const capabilities = parseCapabilities(input.capabilities);
  if (!uuid.test(string(input.environmentId)) || !uuid.test(string(input.generation)) ||
    !workspace.test(string(input.workspaceId))) invalid();
  if (input.expiresInSeconds !== undefined &&
    (!Number.isSafeInteger(input.expiresInSeconds) || Number(input.expiresInSeconds) < 30 || Number(input.expiresInSeconds) > 3_600)) invalid();
  return {
    capabilities,
    environmentId: string(input.environmentId),
    ...(input.expiresInSeconds === undefined ? {} : { expiresInSeconds: Number(input.expiresInSeconds) }),
    generation: string(input.generation),
    workspaceId: string(input.workspaceId)
  };
}

export function parseRegistration(value: unknown): WorkspaceRuntimeRegistration {
  const input = object(value);
  exactKeys(input, [
    'branch', 'commit', 'environmentId', 'generation', 'manifestDigest',
    'resumeAfterSequence', 'runtimeVersion', 'schemaVersion', 'type', 'workspaceId'
  ]);
  if (input.type !== 'runtime.register' || input.schemaVersion !== workspaceRuntimeSessionSchemaVersion ||
    !Number.isSafeInteger(input.resumeAfterSequence) || Number(input.resumeAfterSequence) < 0 ||
    !uuid.test(string(input.environmentId)) ||
    !uuid.test(string(input.generation)) || !workspace.test(string(input.workspaceId)) ||
    !digest.test(string(input.manifestDigest)) || !commit.test(string(input.commit))) invalid();
  return {
    branch: safeText(input.branch, 256), commit: string(input.commit),
    environmentId: string(input.environmentId),
    generation: string(input.generation), manifestDigest: string(input.manifestDigest),
    resumeAfterSequence: Number(input.resumeAfterSequence), runtimeVersion: safeText(input.runtimeVersion, 64),
    schemaVersion: workspaceRuntimeSessionSchemaVersion, type: 'runtime.register',
    workspaceId: string(input.workspaceId)
  };
}

export function parseRuntimeEvent(value: unknown): WorkspaceRuntimeEvent {
  const input = object(value);
  const base = ['eventId', 'observedAt', 'schemaVersion', 'sequence', 'type'];
  if (input.schemaVersion !== workspaceRuntimeSessionSchemaVersion || !eventId.test(string(input.eventId)) ||
    !Number.isSafeInteger(input.sequence) || Number(input.sequence) < 1 || !validTime(input.observedAt)) invalid();
  const common = {
    eventId: string(input.eventId), observedAt: string(input.observedAt),
    schemaVersion: workspaceRuntimeSessionSchemaVersion, sequence: Number(input.sequence)
  };
  if (input.type === 'runtime.heartbeat') {
    exactKeys(input, base);
    return { ...common, type: input.type };
  }
  if (input.type === 'runtime.lifecycle') {
    exactKeys(input, [...base, 'state']);
    if (!['starting', 'running', 'suspended', 'stopping', 'stopped', 'failed'].includes(string(input.state))) invalid();
    return {
      ...common,
      state: input.state as Extract<WorkspaceRuntimeEvent, { type: 'runtime.lifecycle' }>['state'],
      type: input.type
    };
  }
  if (input.type === 'runtime.dev-servers') {
    exactKeys(input, [...base, 'devServers']);
    return { ...common, devServers: parseDevServers(input.devServers), type: input.type };
  }
  if (input.type === 'runtime.telemetry') {
    exactKeys(input, [...base, 'cpuPercent', 'memoryBytes']);
    const cpuPercent = number(input.cpuPercent);
    const memoryBytes = number(input.memoryBytes);
    if (cpuPercent < 0 || cpuPercent > 100 || !Number.isSafeInteger(memoryBytes) || memoryBytes < 0) invalid();
    return { ...common, cpuPercent, memoryBytes, type: input.type };
  }
  if (input.type === 'runtime.log-pointer') {
    exactKeys(input, [...base, 'pointer']);
    const pointer = safeText(input.pointer, 512);
    if (!/^runtime-log:\/[A-Za-z0-9._/-]{1,498}$/.test(pointer) || pointer.includes('..')) invalid();
    return { ...common, pointer, type: input.type };
  }
  invalid();
}

function parseDevServers(value: unknown): WorkspaceRuntimeDevServer[] {
  if (!Array.isArray(value) || value.length > 32) invalid();
  const names = new Set<string>();
  return value.map((entry) => {
    const input = object(entry);
    exactKeys(input, ['name', 'port', 'state', 'url'], ['url']);
    const name = safeText(input.name, 64);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) || names.has(name) ||
      !Number.isSafeInteger(input.port) || Number(input.port) < 1 || Number(input.port) > 65_535 ||
      !['starting', 'ready', 'stopped', 'failed'].includes(string(input.state))) invalid();
    names.add(name);
    return {
      name, port: Number(input.port), state: input.state as WorkspaceRuntimeDevServer['state'],
      ...(input.url === undefined ? {} : { url: safeUrl(input.url) })
    };
  });
}

export function parseCapabilities(value: unknown): WorkspaceRuntimeCapability[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > workspaceRuntimeCapabilities.length) invalid();
  const capabilities = value.map(string);
  if (new Set(capabilities).size !== capabilities.length || capabilities.some((entry) => !capabilitySet.has(entry))) invalid();
  return capabilities.sort() as WorkspaceRuntimeCapability[];
}

function safeUrl(value: unknown) {
  const raw = safeText(value, 2_048);
  let parsed: URL;
  try { parsed = new URL(raw); } catch { invalid(); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) invalid();
  return parsed.toString();
}

function validTime(value: unknown) {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
}

function safeText(value: unknown, maximum: number) {
  const result = string(value);
  if (!result || result.length > maximum || /[\u0000-\u001f\u007f]/.test(result)) invalid();
  return result;
}

function exactKeys(input: Record<string, unknown>, keys: string[], optional: string[] = []) {
  const actual = Object.keys(input).sort();
  const expected = keys.filter((key) => input[key] !== undefined || !optional.includes(key)).sort();
  if (actual.join('\0') !== expected.join('\0')) invalid();
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function string(value: unknown) {
  if (typeof value !== 'string') invalid();
  return value;
}

function number(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid();
  return value;
}

function invalid(): never {
  throw new RuntimeSessionError('invalid_message', 'Workspace Runtime session message is invalid.');
}
