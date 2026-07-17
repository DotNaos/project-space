export type CodexRpcId = number | string;

export type CodexThreadStatus =
  | { type: 'notLoaded' }
  | { type: 'idle' }
  | { type: 'systemError' }
  | { activeFlags?: string[]; type: 'active' };

export interface CodexThreadSummary {
  archived?: boolean;
  createdAt?: number;
  cwd?: string;
  ephemeral?: boolean;
  id: string;
  model?: string;
  modelProvider?: string;
  name?: string | null;
  preview?: string;
  source?: unknown;
  status?: CodexThreadStatus;
  turns?: unknown[];
  updatedAt?: number;
  [key: string]: unknown;
}

export interface CodexThreadListInput {
  archived?: boolean;
  cursor?: string;
  limit?: number;
  searchTerm?: string;
  sortDirection?: 'asc' | 'desc';
  sortKey?: 'created_at' | 'recency_at' | 'updated_at';
}

export interface CodexThreadListResult {
  data: CodexThreadSummary[];
  nextCursor: string | null;
}

export interface CodexLoadedThreadListResult {
  data: string[];
}

export interface CodexThreadResult {
  thread: CodexThreadSummary;
}

export interface CodexTurnResult {
  turn: {
    error?: unknown;
    id: string;
    items?: unknown[];
    status?: string;
    [key: string]: unknown;
  };
}

export interface CodexMutationInput {
  operationId: string;
}

export interface CodexResumeThreadInput extends CodexMutationInput {
  threadId: string;
}

export interface CodexStartTurnInput extends CodexMutationInput {
  effort?: string;
  model?: string;
  prompt: string;
  serviceTier?: string | null;
  threadId: string;
}

export interface CodexInterruptTurnInput extends CodexMutationInput {
  threadId: string;
  turnId: string;
}

export type CodexApprovalDecision =
  | 'accept'
  | 'acceptForSession'
  | 'cancel'
  | 'decline';

export interface CodexApprovalResponseInput extends CodexMutationInput {
  decision: CodexApprovalDecision;
  requestId: CodexRpcId;
  threadId: string;
  turnId?: string;
}

export interface CodexPermissionResponseInput extends CodexMutationInput {
  grant: 'allRequested' | 'none';
  requestId: CodexRpcId;
  scope?: 'session' | 'turn';
  threadId: string;
  turnId: string;
}

export interface CodexUserInputResponseInput extends CodexMutationInput {
  answers: Record<string, string[]>;
  requestId: CodexRpcId;
  threadId: string;
  turnId?: string;
}

export const codexNotificationMethods = [
  'error',
  'item/agentMessage/delta',
  'item/commandExecution/outputDelta',
  'item/completed',
  'item/plan/delta',
  'item/reasoning/summaryPartAdded',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/textDelta',
  'item/started',
  'serverRequest/resolved',
  'thread/closed',
  'thread/started',
  'thread/status/changed',
  'turn/completed',
  'turn/diff/updated',
  'turn/plan/updated',
  'turn/started'
] as const;

export const codexServerRequestMethods = [
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'item/tool/requestUserInput',
  'tool/requestUserInput'
] as const;

export type CodexNotificationMethod = (typeof codexNotificationMethods)[number];
export type CodexServerRequestMethod = (typeof codexServerRequestMethods)[number];

export interface CodexSessionEvent {
  kind: 'notification' | 'request';
  method: CodexNotificationMethod | CodexServerRequestMethod;
  params: unknown;
  requestId?: CodexRpcId;
}

export type CodexSessionEventListener = (event: CodexSessionEvent) => void;

export type CodexOperationSnapshot = Array<{
  fingerprint: string;
  operationId: string;
  result?: unknown;
  state: 'completed' | 'uncertain';
}>;

export interface CodexChildProcess {
  exitCode: number | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: 'error', listener: (error: Error) => void): this;
  once(event: 'close', listener: () => void): this;
  signalCode: NodeJS.Signals | null;
  stderr: NodeJS.ReadableStream;
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
}

export type CodexProcessFactory = (options: {
  args: readonly string[];
  command: string;
  env: NodeJS.ProcessEnv;
}) => CodexChildProcess;
