import type { CodexConversationItemKind } from '@/shared/codex-sessions-api';

export type CodexMachineStatus = 'connected' | 'offline' | 'unavailable';

export type CodexSessionStatus =
  | 'active'
  | 'idle'
  | 'archived'
  | 'missing'
  | 'unavailable'
  | 'offline';

export type ProjectCodexTaskStatus = CodexSessionStatus
  | 'waiting-approval'
  | 'waiting-input';

export interface CodexMachine {
  id: string;
  name: string;
  status: CodexMachineStatus;
  lastSeenAt?: string;
  statusDetail?: string;
  supportsModelSelection?: boolean;
  supportsModelSettings?: boolean;
}

export interface CodexSession {
  attention?: 'approval' | 'input';
  cwd?: string;
  lastActivityAt: string;
  loadedByProjectSpace: boolean;
  machineId: string;
  model?: string;
  projectName?: string;
  status: CodexSessionStatus;
  statusDetail?: string;
  stored: boolean;
  threadId: string;
  title: string;
}

export type CodexConversationItem =
  | {
      id: string;
      kind: 'message';
      role: 'assistant' | 'user';
      text: string;
      createdAt?: string;
      streaming?: boolean;
    }
  | {
      activityKind?: Exclude<CodexConversationItemKind, 'agent-message' | 'user-message'>;
      id: string;
      kind: 'activity';
      label: string;
      detail?: string;
      state: 'completed' | 'failed' | 'running' | 'waiting';
    };

export interface CodexApprovalRequest {
  canAllow: boolean;
  description: string;
  id: string;
  title: string;
}

export interface CodexUserInputQuestion {
  choices: Array<{ description?: string; value: string }>;
  id: string;
  prompt: string;
}

export interface CodexUserInputRequest {
  id: string;
  questions: CodexUserInputQuestion[];
  title: string;
}

export interface CodexConversation {
  approvals?: CodexApprovalRequest[];
  items: CodexConversationItem[];
  machineId: string;
  threadId: string;
  userInputRequests?: CodexUserInputRequest[];
}

export interface CodexThreadOrigin {
  machineId: string;
  threadId: string;
}

export interface CodexApprovalDecision extends CodexThreadOrigin {
  decision: 'allow_once' | 'deny';
  requestId: string;
}

export interface CodexUserInputDecision extends CodexThreadOrigin {
  answers: Array<{ questionId: string; value: string }>;
  requestId: string;
}
