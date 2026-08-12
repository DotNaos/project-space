import {
  workspaceRuntimeBaseCapabilities,
  workspaceRuntimeControlCapability,
  workspaceRuntimeReadyCapabilities,
  workspaceRuntimeSessionSchemaVersion,
  type WorkspaceRuntimeBaseCapability,
  type WorkspaceRuntimeReadyCapability,
  type WorkspaceRuntimeCredentialRequest,
  type WorkspaceRuntimeDevServer,
  type WorkspaceRuntimeEvent,
  type WorkspaceRuntimeRegistration
} from '../../src/shared/workspace-runtime-session-api';
import type { IssueRuntimeCredentialInput } from './contracts';
import type { RuntimeCredentialScope } from './contracts';
import type { WorkspaceRuntimeCodexMessage } from '../../src/shared/workspace-runtime-codex-api';
import type { WorkspaceRuntimeControlMessage } from '../../src/shared/workspace-runtime-control-api';
import { canonicalRuntimeControlOperations } from '../../src/shared/canonical-runtime-control-api';
import { RuntimeSessionError } from './contracts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const workspace = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const commit = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const eventId = /^[A-Za-z0-9:._-]{1,128}$/;
const baseCapabilitySet = new Set<string>(workspaceRuntimeBaseCapabilities);
const readyCapabilitySet = new Set<string>([
  ...workspaceRuntimeReadyCapabilities,
  workspaceRuntimeControlCapability
]);

export function validateCredentialIssue(input: IssueRuntimeCredentialInput) {
  const expiresInSeconds = input.expiresInSeconds ?? 300;
  if (!input.ownerUserId.trim() || input.ownerUserId.length > 256 ||
    !workspace.test(input.workspaceId) || !uuid.test(input.environmentId) || !uuid.test(input.generation) ||
    !commit.test(input.commit) || !digest.test(input.manifestDigest) ||
    !/^[A-Za-z0-9:._-]{1,256}$/.test(input.operationId) ||
    !Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 30 || expiresInSeconds > 3_600) invalid();
  safeText(input.branch, 256);
  safeText(input.runtimeVersion, 64);
  parseCapabilities(input.capabilities);
  parseRequestedCapabilities(input.requestedCapabilities);
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
    'branch', 'commit', 'environmentId', 'generation', 'manifestDigest', 'readyCapabilities',
    'resumeAfterCodexCommandSequence', 'resumeAfterCodexEventSequence', 'resumeAfterSequence',
    'resumeAfterControlCommandSequence', 'resumeAfterControlEventSequence',
    'runtimeVersion', 'schemaVersion', 'type', 'workspaceId'
  ], [
    'readyCapabilities', 'resumeAfterCodexCommandSequence', 'resumeAfterCodexEventSequence',
    'resumeAfterControlCommandSequence', 'resumeAfterControlEventSequence'
  ]);
  if (input.type !== 'runtime.register' || input.schemaVersion !== workspaceRuntimeSessionSchemaVersion ||
    !Number.isSafeInteger(input.resumeAfterSequence) || Number(input.resumeAfterSequence) < 0 ||
    !optionalSequence(input.resumeAfterCodexCommandSequence) ||
    !optionalSequence(input.resumeAfterCodexEventSequence) ||
    !optionalSequence(input.resumeAfterControlCommandSequence) ||
    !optionalSequence(input.resumeAfterControlEventSequence) ||
    !uuid.test(string(input.environmentId)) ||
    !uuid.test(string(input.generation)) || !workspace.test(string(input.workspaceId)) ||
    !digest.test(string(input.manifestDigest)) || !commit.test(string(input.commit))) invalid();
  const readyCapabilities = input.readyCapabilities === undefined
    ? undefined
    : parseRequestedCapabilities(input.readyCapabilities, false);
  const codexReady = readyCapabilities?.includes('runtime.codex.v1') ?? false;
  const controlReady = readyCapabilities?.includes(workspaceRuntimeControlCapability) ?? false;
  if (codexReady !== (input.resumeAfterCodexCommandSequence !== undefined) ||
      codexReady !== (input.resumeAfterCodexEventSequence !== undefined) ||
      controlReady !== (input.resumeAfterControlCommandSequence !== undefined) ||
      controlReady !== (input.resumeAfterControlEventSequence !== undefined)) invalid();
  return {
    branch: safeText(input.branch, 256),
    commit: string(input.commit),
    environmentId: string(input.environmentId),
    generation: string(input.generation), manifestDigest: string(input.manifestDigest),
    ...(readyCapabilities === undefined ? {} : { readyCapabilities }),
    ...(input.resumeAfterCodexCommandSequence === undefined ? {} : {
      resumeAfterCodexCommandSequence: Number(input.resumeAfterCodexCommandSequence)
    }),
    ...(input.resumeAfterCodexEventSequence === undefined ? {} : {
      resumeAfterCodexEventSequence: Number(input.resumeAfterCodexEventSequence)
    }),
    ...(input.resumeAfterControlCommandSequence === undefined ? {} : {
      resumeAfterControlCommandSequence: Number(input.resumeAfterControlCommandSequence)
    }),
    ...(input.resumeAfterControlEventSequence === undefined ? {} : {
      resumeAfterControlEventSequence: Number(input.resumeAfterControlEventSequence)
    }),
    resumeAfterSequence: Number(input.resumeAfterSequence), runtimeVersion: safeText(input.runtimeVersion, 64),
    schemaVersion: workspaceRuntimeSessionSchemaVersion, type: 'runtime.register',
    workspaceId: string(input.workspaceId)
  };
}

function optionalSequence(value: unknown) {
  return value === undefined || Number.isSafeInteger(value) && Number(value) >= 0;
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

export function parseRuntimeCodexMessage(
  value: unknown,
  scope: RuntimeCredentialScope,
  sessionId: string
): WorkspaceRuntimeCodexMessage {
  if (!scope.capabilities.includes('runtime.codex.v1')) invalid();
  const input = object(value);
  if (![
    'runtime.codex.command-accepted', 'runtime.codex.event', 'runtime.codex.result',
    'runtime.codex.error'
  ].includes(string(input.type)) || input.schemaVersion !== 1 ||
      input.workspaceId !== scope.workspaceId || input.environmentId !== scope.environmentId ||
      input.generation !== scope.generation || input.sessionId !== sessionId ||
      input.actorUserId !== scope.ownerUserId || !eventId.test(string(input.actorId)) ||
      !eventId.test(string(input.commandId)) || !eventId.test(string(input.operationId)) ||
      !Number.isSafeInteger(input.commandSequence) || Number(input.commandSequence) < 1) invalid();
  if (input.type === 'runtime.codex.event' &&
      (!Number.isSafeInteger(input.eventSequence) || Number(input.eventSequence) < 1)) invalid();
  return input as unknown as WorkspaceRuntimeCodexMessage;
}

export function parseRuntimeControlMessage(
  value: unknown,
  scope: RuntimeCredentialScope,
  sessionId: string
): WorkspaceRuntimeControlMessage {
  if (!scope.capabilities.includes(workspaceRuntimeControlCapability)) invalid();
  const input = object(value);
  const baseKeys = [
    'actorId', 'actorKind', 'actorUserId', 'commandId', 'commandSequence', 'environmentId',
    'eventSequence', 'generation', 'operation', 'operationId', 'schemaVersion', 'sessionId',
    'targetIdentityRevision', 'type', 'workspaceId'
  ];
  if (![
    'runtime.control.command-accepted', 'runtime.control.result', 'runtime.control.error'
  ].includes(string(input.type)) || input.schemaVersion !== 1 ||
      input.workspaceId !== scope.workspaceId || input.environmentId !== scope.environmentId ||
      input.generation !== scope.generation || input.sessionId !== sessionId ||
      input.actorUserId !== scope.ownerUserId || !eventId.test(string(input.actorId)) ||
      !eventId.test(string(input.commandId)) || !eventId.test(string(input.operationId)) ||
      !['agent', 'human', 'orchestrator', 'system'].includes(string(input.actorKind)) ||
      !canonicalRuntimeControlOperations.includes(input.operation as never) ||
      !/^[1-9][0-9]*:[A-Za-z0-9:_-]{8,256}$/.test(string(input.targetIdentityRevision)) ||
      !Number.isSafeInteger(input.commandSequence) || Number(input.commandSequence) < 1 ||
      !Number.isSafeInteger(input.eventSequence) || Number(input.eventSequence) < 1) invalid();
  if (input.type === 'runtime.control.command-accepted') {
    exactKeys(input, [...baseKeys, 'acceptedCommandSequence', 'replayed']);
    if (typeof input.replayed !== 'boolean' ||
      (!Number.isSafeInteger(input.acceptedCommandSequence) ||
       Number(input.acceptedCommandSequence) !== Number(input.commandSequence))) invalid();
  }
  if (input.type === 'runtime.control.result') {
    const completed = input.state === 'completed';
    exactKeys(input, [...baseKeys, 'state', ...(completed ? ['output'] : [])]);
    if (!['completed', 'failed'].includes(string(input.state)) ||
        completed !== (input.output !== undefined)) invalid();
    if (completed) parseRuntimeControlOutput(string(input.operation), input.output);
  }
  if (input.type === 'runtime.control.error') {
    exactKeys(input, [...baseKeys, 'code', 'message']);
    if (!['invalid_command', 'runtime_stopping', 'unavailable', 'uncertain'].includes(string(input.code))) invalid();
    safeText(input.message, 512);
  }
  return input as unknown as WorkspaceRuntimeControlMessage;
}

function parseRuntimeControlOutput(operation: string, value: unknown) {
  const input = object(value);
  if (operation === 'git.status') {
    exactKeys(input, ['clean', 'conflicted', 'staged', 'truncated', 'unstaged', 'untracked']);
    if (typeof input.clean !== 'boolean' || typeof input.truncated !== 'boolean') invalid();
    nonNegativeCounts(input, ['conflicted', 'staged', 'unstaged', 'untracked']);
    if (input.clean !== ['conflicted', 'staged', 'unstaged', 'untracked']
      .every((key) => input[key] === 0)) invalid();
    return;
  }
  if (operation === 'git.diff') {
    exactKeys(input, ['addedLines', 'binaryFiles', 'changedFiles', 'deletedLines', 'staged', 'truncated']);
    if (typeof input.staged !== 'boolean' || typeof input.truncated !== 'boolean') invalid();
    nonNegativeCounts(input, ['addedLines', 'binaryFiles', 'changedFiles', 'deletedLines']);
    if (Number(input.binaryFiles) > Number(input.changedFiles)) invalid();
    return;
  }
  if (operation === 'worktree.list') {
    exactKeys(input, ['current', 'detached', 'locked', 'prunable', 'total', 'truncated']);
    if (typeof input.truncated !== 'boolean') invalid();
    nonNegativeCounts(input, ['current', 'detached', 'locked', 'prunable', 'total']);
    if (Number(input.current) > 1 || ['current', 'detached', 'locked', 'prunable']
      .some((key) => Number(input[key]) > Number(input.total))) invalid();
    return;
  }
  if (operation === 'dev-server.inspect') {
    exactKeys(input, ['failed', 'ready', 'starting', 'stopped', 'total']);
    nonNegativeCounts(input, ['failed', 'ready', 'starting', 'stopped', 'total']);
    if (['failed', 'ready', 'starting', 'stopped']
      .reduce((total, key) => total + Number(input[key]), 0) !== input.total) invalid();
    return;
  }
  invalid();
}

function nonNegativeCounts(input: Record<string, unknown>, keys: string[]) {
  if (keys.some((key) => !Number.isSafeInteger(input[key]) || Number(input[key]) < 0)) invalid();
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

export function parseCapabilities(value: unknown): WorkspaceRuntimeBaseCapability[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > workspaceRuntimeBaseCapabilities.length) invalid();
  const capabilities = value.map(string);
  if (new Set(capabilities).size !== capabilities.length || capabilities.some((entry) => !baseCapabilitySet.has(entry))) invalid();
  return capabilities.sort() as WorkspaceRuntimeBaseCapability[];
}

export function parseRequestedCapabilities(value: unknown, allowEmpty = true) {
  if (!Array.isArray(value) || value.length > readyCapabilitySet.size ||
      !allowEmpty && value.length === 0) invalid();
  const capabilities = value.map(string);
  if (new Set(capabilities).size !== capabilities.length ||
      capabilities.some((entry) => !readyCapabilitySet.has(entry))) invalid();
  return capabilities.sort() as WorkspaceRuntimeReadyCapability[];
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
