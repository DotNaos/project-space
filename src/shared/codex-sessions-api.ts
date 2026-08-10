export const CODEX_THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CODEX_OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
export const CODEX_PERMISSION_PROFILE_ID_PATTERN =
  /^(?::[A-Za-z0-9][A-Za-z0-9._-]*|[A-Za-z0-9][A-Za-z0-9._:-]*)$/;

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
  supportsModelSelection?: boolean;
  supportsModelSettings?: boolean;
}

export interface CodexSessionTaskLocationEvidence {
  canonicalCwd: string;
  checkedAt: string;
  machineId: string;
  sessionRevision: string;
  source: 'connector-realpath';
  threadId: string;
  worktreeRoot: string;
}

export type CodexSessionWriteCapability =
  | {
      canContinue: boolean;
      checkedAt: string;
      expiresAt: string;
      interruptTurnId?: string;
      machineId: string;
      sessionRevision: string;
      sessionLastActivityAt: string;
      state: 'ready';
      threadId: string;
    }
  | {
      checkedAt?: string;
      reason: string;
      state: 'unavailable';
    };

export interface CodexSessionRecord {
  attention?: 'approval' | 'input';
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
  /** Oldest observation included in this complete inventory. */
  checkedAt: string;
  /**
   * Hosted-service evidence for whether this response came from a verified live
   * connector scan or a saved fallback. Omitted by older servers.
   */
  inventoryState?: 'live' | 'stale';
  machine: CodexSessionMachineRecord;
  /** Completion time for the full scan. Omitted only by older connector versions. */
  publishedAt?: string;
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

export interface CodexConversationImageRecord {
  dataUrl: string;
  id: string;
  mediaType: 'image/jpeg' | 'image/png';
}

export interface CodexConversationItemRecord {
  detail?: string;
  id: string;
  images?: CodexConversationImageRecord[];
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
  connectorGeneration?: number;
  machineId: string;
  threadId: string;
}

export interface CodexSessionPermissionProfile {
  allowed: boolean;
  description?: string;
  id: string;
}

export interface CodexSessionTokenUsageBreakdown {
  cachedInputTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface CodexSessionTokenUsage {
  last: CodexSessionTokenUsageBreakdown;
  modelContextWindow?: number;
  total: CodexSessionTokenUsageBreakdown;
}

export interface CodexSessionBrowserRequest {
  afterImageRevision?: string;
  machineId: string;
  threadId: string;
}

/**
 * Leaves enough room for the signed result wrapper inside the connector's 2 MiB
 * WebSocket message limit after base64 and JSON expansion.
 */
export const CODEX_BROWSER_MAXIMUM_IMAGE_BYTES = 1_500_000;

export interface CodexSessionBrowserResultBase {
  checkedAt: string;
  imageRevision?: string;
  imageUnchanged?: true;
  machineId: string;
  observedAt?: string;
  pageUrl?: string;
  reason?: string;
  threadId: string;
  turnId?: string;
}

export type CodexSessionBrowserResult =
  | (CodexSessionBrowserResultBase & {
      state: 'never-used' | 'loading' | 'unavailable';
    })
  | (CodexSessionBrowserResultBase & {
      imageDataUrl?: string;
      state: 'live';
    })
  | (CodexSessionBrowserResultBase & {
      imageDataUrl?: string;
      state: 'ended';
    });

export interface CodexSessionReadResult {
  openedReadOnly: true;
  pendingRequests?: CodexSessionAttentionRequest[];
  permissionProfileId?: string;
  permissionProfiles?: CodexSessionPermissionProfile[];
  session: CodexSessionRecord;
  streamCursor?: number;
  tokenUsage?: CodexSessionTokenUsage;
  turns: CodexConversationTurnRecord[];
}

export interface CodexSessionInspectRequest extends CodexSessionReadRequest {}

export interface CodexSessionInspectResult {
  activeTurnId?: string;
  checkedAt: string;
  openedReadOnly: true;
  session: CodexSessionRecord;
  sessionRevision: string;
  taskLocation: CodexSessionTaskLocationEvidence;
  writeCapability?: CodexSessionWriteCapability;
}

export interface CodexSessionSubscribeRequest extends CodexSessionReadRequest {
  afterSequence?: number;
}

export interface CodexSessionTurnSettings {
  effort?: string;
  model: string;
  serviceTier?: string | null;
}

export interface CodexSessionContinueRequest {
  connectorGeneration?: number;
  delivery?: 'new-turn' | 'steer';
  effort?: string;
  expectedTurnId?: string;
  imageAttachmentIds?: string[];
  machineId: string;
  message: string;
  model?: string;
  operationId: string;
  permissionProfileId?: string;
  serviceTier?: string | null;
  threadId: string;
}

export interface CodexSessionInterruptRequest {
  connectorGeneration?: number;
  machineId: string;
  operationId: string;
  threadId: string;
  turnId: string;
}

export interface CodexSessionSettingsRequest {
  machineId: string;
  operationId: string;
  permissionProfileId: string;
  threadId: string;
}

export interface CodexSessionApprovalRequest {
  approvalId?: string;
  connectorGeneration?: number;
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
  connectorGeneration?: number;
  machineId: string;
  operationId: string;
  requestId: string;
  threadId: string;
  turnId: string;
}

export interface CodexSessionOperationResult {
  operationId: string;
  reason?: 'thread_active' | 'unavailable';
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
  | {
      eventId: string;
      permissionProfileId?: string;
      type: 'session-settings';
    }
  | {
      eventId: string;
      tokenUsage: CodexSessionTokenUsage;
      type: 'token-usage';
      turnId: string;
    }
  | { eventId: string; reason?: string; type: 'turn-completed'; turnId: string };

export type CodexSessionAttentionRequest = Extract<
  CodexSessionStreamEvent,
  { type: 'approval-requested' | 'user-input-requested' }
>;

export interface CodexSessionsClient {
  approve(request: CodexSessionApprovalRequest): Promise<CodexSessionOperationResult>;
  browser(request: CodexSessionBrowserRequest): Promise<CodexSessionBrowserResult>;
  continue(request: CodexSessionContinueRequest): Promise<CodexSessionOperationResult>;
  interrupt(request: CodexSessionInterruptRequest): Promise<CodexSessionOperationResult>;
  inspect?(request: CodexSessionInspectRequest): Promise<CodexSessionInspectResult>;
  list(request: CodexSessionListRequest): Promise<CodexSessionListResult>;
  read(request: CodexSessionReadRequest): Promise<CodexSessionReadResult>;
  settings(request: CodexSessionSettingsRequest): Promise<CodexSessionOperationResult>;
  respondToUserInput(
    request: CodexSessionUserInputResponse
  ): Promise<CodexSessionOperationResult>;
  subscribe(
    request: CodexSessionSubscribeRequest,
    onEvent: (event: CodexSessionStreamEvent) => void,
    onError?: (error: unknown) => void
  ): () => void;
}
