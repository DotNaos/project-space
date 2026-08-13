/**
 * Compatibility exports for callers that have not yet migrated off the old
 * Connector command channel. No Connector request is accepted or dispatched.
 * Canonical Codex traffic belongs to the Workspace Runtime session.
 */

export interface CodexSessionsHubRequestOptions {
  generation?: number;
  grantTtlMs?: number;
  nonce?: string;
  now?: number;
  operationId?: string;
  onDispatched?: () => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  userId: string;
}

export interface CodexConnectorAttachTunnel {
  close(): void;
  send(message: string): void;
}

export interface CodexConnectorAttachOptions extends CodexSessionsHubRequestOptions {
  onClose(code: string): void;
  onMessage(message: string): void;
}

export class CodexConnectorRemoteError extends Error {
  constructor(readonly code: 'rejected' | 'unavailable') {
    super('The legacy Codex Connector channel is retired.');
    this.name = 'CodexConnectorRemoteError';
  }
}

export class CodexConnectorNotDispatchedError extends Error {
  constructor() {
    super('Codex requires the canonical Environment and Workspace Runtime.');
    this.name = 'CodexConnectorNotDispatchedError';
  }
}

export class CodexConnectorOutcomeUnknownError extends Error {
  constructor() {
    super('The legacy Codex Connector command was not dispatched.');
    this.name = 'CodexConnectorOutcomeUnknownError';
  }
}

export async function requestConnectorCodexSessions(
  _operation: string,
  _payload: unknown,
  _options: CodexSessionsHubRequestOptions
): Promise<never> {
  throw new CodexConnectorNotDispatchedError();
}

export function openConnectorCodexAttach(
  _input: unknown,
  _options: CodexConnectorAttachOptions
): never {
  throw new CodexConnectorNotDispatchedError();
}

export async function streamConnectorCodexSessions(
  _payload: unknown,
  _emit: (event: unknown) => void,
  _options: CodexSessionsHubRequestOptions
): Promise<never> {
  throw new CodexConnectorNotDispatchedError();
}

export function handleCodexSessionsConnectorMessage(
  _machineId: string,
  _message: unknown,
  _options?: unknown
) {
  return false;
}

export function failCodexSessionCommandsForMachine(_machineId: string) {}

export function codexCompatibilitySurface(_operation: string) {
  return 'runtime.codex.v1' as const;
}

export function successfulCodexCompatibilityResult(_value: unknown) {
  return false;
}
