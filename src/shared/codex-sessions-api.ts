export const CODEX_THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CODEX_OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

export type CodexSessionStatus =
  | 'active'
  | 'archived'
  | 'idle'
  | 'missing'
  | 'offline'
  | 'unavailable';

export interface CodexSessionMachineRecord {
  id: string;
  name: string;
  online: boolean;
  statusMessage?: string;
}

export interface CodexSessionRecord {
  archived: boolean;
  cwd?: string;
  id: string;
  lastActivityAt: string;
  loadedByProjectSpace: boolean;
  machineId: string;
  machineName: string;
  model?: string;
  modelProvider?: string;
  project?: string;
  source?: string;
  status: CodexSessionStatus;
  title: string;
}

export interface CodexSessionListRequest {
  includeArchived?: boolean;
  machineId: string;
  search?: string;
}

export interface CodexSessionListResult {
  checkedAt: string;
  machine: CodexSessionMachineRecord;
  sessions: CodexSessionRecord[];
}

export type CodexConversationItemKind =
  | 'agent-message'
  | 'command'
  | 'file-change'
  | 'mcp-tool'
  | 'plan'
  | 'reasoning'
  | 'status'
  | 'user-message';

export interface CodexConversationItemRecord {
  detail?: string;
  id: string;
  kind: CodexConversationItemKind;
  status?: 'completed' | 'failed' | 'in-progress' | 'pending';
  text?: string;
}

export interface CodexConversationTurnRecord {
  completedAt?: string;
  id: string;
  items: CodexConversationItemRecord[];
  startedAt?: string;
  status: 'completed' | 'failed' | 'in-progress' | 'interrupted';
}

export interface CodexSessionReadRequest {
  machineId: string;
  threadId: string;
}

export interface CodexSessionReadResult {
  openedReadOnly: true;
  session: CodexSessionRecord;
  turns: CodexConversationTurnRecord[];
}

export interface CodexSessionContinueRequest {
  machineId: string;
  message: string;
  operationId: string;
  threadId: string;
}

export interface CodexSessionInterruptRequest {
  machineId: string;
  operationId: string;
  threadId: string;
  turnId: string;
}

export interface CodexSessionApprovalRequest {
  approvalId?: string;
  decision: 'allow-once' | 'deny';
  itemId?: string;
  machineId: string;
  operationId: string;
  requestId: string;
  threadId: string;
  turnId: string;
}

export interface CodexSessionUserInputAnswer {
  questionId: string;
  value: string;
}

export interface CodexSessionUserInputResponse {
  answers: CodexSessionUserInputAnswer[];
  machineId: string;
  operationId: string;
  requestId: string;
  threadId: string;
  turnId: string;
}

export interface CodexSessionOperationResult {
  operationId: string;
  replayed: boolean;
  status: 'accepted' | 'ambiguous' | 'completed' | 'rejected';
  threadId: string;
  turnId?: string;
}

export interface CodexSessionApprovalEvent {
  approvalId?: string;
  canAllow?: boolean;
  command?: string;
  itemId?: string;
  kind: 'command' | 'file-change' | 'permissions';
  permissionSummary?: string[];
  requestId: string;
  turnId: string;
  type: 'approval-requested';
}

export interface CodexSessionUserInputQuestion {
  choices?: Array<{ label: string; value: string }>;
  id: string;
  prompt: string;
}

export type CodexSessionStreamEvent =
  | { eventId: string; item: CodexConversationItemRecord; type: 'item' }
  | { delta: string; eventId: string; itemId: string; type: 'agent-message-delta' }
  | { eventId: string; status: CodexSessionStatus; type: 'session-status' }
  | ({ eventId: string } & CodexSessionApprovalEvent)
  | {
      eventId: string;
      questions: CodexSessionUserInputQuestion[];
      requestId: string;
      turnId: string;
      type: 'user-input-requested';
    }
  | { eventId: string; reason?: string; type: 'turn-completed'; turnId: string };

export interface CodexSessionsClient {
  approve(request: CodexSessionApprovalRequest): Promise<CodexSessionOperationResult>;
  continue(request: CodexSessionContinueRequest): Promise<CodexSessionOperationResult>;
  interrupt(request: CodexSessionInterruptRequest): Promise<CodexSessionOperationResult>;
  list(request: CodexSessionListRequest): Promise<CodexSessionListResult>;
  read(request: CodexSessionReadRequest): Promise<CodexSessionReadResult>;
  respondToUserInput(
    request: CodexSessionUserInputResponse
  ): Promise<CodexSessionOperationResult>;
  subscribe(
    request: CodexSessionReadRequest,
    onEvent: (event: CodexSessionStreamEvent) => void,
    onError?: (error: unknown) => void
  ): () => void;
}
