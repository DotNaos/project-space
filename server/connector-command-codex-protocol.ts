import {
  isCodexSessionsWireRequest,
  type CodexSessionsWireRequest
} from './codex-sessions-connector-contract';
import {
  isBoundCodexAttachChunk,
  isBoundCodexAttachClosed,
  isBoundCodexAttachReady,
  isBoundCodexSessionsCompletion,
  isBoundCodexSessionsError,
  isBoundCodexSessionsEvent,
  isBoundCodexSessionsResult,
  type BoundCodexAttachChunk,
  type BoundCodexAttachClosed,
  type BoundCodexAttachReady,
  type BoundCodexSessionsCompletion,
  type BoundCodexSessionsError,
  type BoundCodexSessionsEvent,
  type BoundCodexSessionsResult
} from './codex-sessions/connector-channel';

export type ConnectorCodexHubMessage =
  | { id: string; payload: BoundCodexSessionsResult; type: 'codex.sessions.result' }
  | { id: string; payload: BoundCodexSessionsEvent; type: 'codex.sessions.event' }
  | { id: string; payload: BoundCodexSessionsCompletion; type: 'codex.sessions.complete' }
  | { id: string; payload: BoundCodexSessionsError; type: 'codex.sessions.error' }
  | { id: string; payload: BoundCodexAttachReady; type: 'codex.attach.ready' }
  | { id: string; payload: BoundCodexAttachChunk; type: 'codex.attach.output' }
  | { id: string; payload: BoundCodexAttachClosed; type: 'codex.attach.closed' };

export type ConnectorCodexMachineMessage =
  | { id: string; payload: CodexSessionsWireRequest; type: 'codex.sessions.command' }
  | { id: string; payload: BoundCodexAttachChunk; type: 'codex.attach.input' };

function hasCommandId(value: Record<string, unknown>) {
  return typeof value.id === 'string' && value.id.length > 0;
}

export function isConnectorCodexHubMessage(
  value: Record<string, unknown>
): value is ConnectorCodexHubMessage {
  if (!hasCommandId(value)) return false;
  if (value.type === 'codex.sessions.result') return isBoundCodexSessionsResult(value.payload);
  if (value.type === 'codex.sessions.event') return isBoundCodexSessionsEvent(value.payload);
  if (value.type === 'codex.sessions.complete') return isBoundCodexSessionsCompletion(value.payload);
  if (value.type === 'codex.sessions.error') return isBoundCodexSessionsError(value.payload);
  if (value.type === 'codex.attach.ready') return isBoundCodexAttachReady(value.payload);
  if (value.type === 'codex.attach.output') return isBoundCodexAttachChunk(value.payload);
  if (value.type === 'codex.attach.closed') return isBoundCodexAttachClosed(value.payload);
  return false;
}

export function isConnectorCodexMachineMessage(
  value: Record<string, unknown>
): value is ConnectorCodexMachineMessage {
  if (!hasCommandId(value)) return false;
  if (value.type === 'codex.sessions.command') return isCodexSessionsWireRequest(value.payload);
  if (value.type === 'codex.attach.input') return isBoundCodexAttachChunk(value.payload);
  return false;
}
