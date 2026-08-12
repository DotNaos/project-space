import type { KeyLike } from 'node:crypto';

import type { CodexSessionBrowserResult } from '../../src/shared/codex-sessions-api';
import type {
  CodexMachineTaskConnectorStartRequest,
  CodexMachineTaskConnectorStartResult
} from '../../src/shared/codex-machine-tasks-api';
import type { CodexSessionsGrantReplayProtection } from '../codex-sessions-connector-contract';
import type { CodexStartTurnInput, CodexSteerTurnInput } from './contracts';
import type { CodexSessionManager } from './index';
import type { CodexTaskLocationResolver } from './task-access-evidence';
import type { LocalCodexTranscriptSource } from './transcript-reader';

export interface CodexSessionsConnectorExecutorOptions {
  expectedGeneration: number | (() => number);
  expectedMachineId: string;
  machineName: string;
  manager: CodexSessionManager;
  now?: () => number;
  readBrowserSnapshot?: (
    machineId: string,
    threadId: string,
    options?: { afterImageRevision?: string }
  ) => Promise<CodexSessionBrowserResult>;
  replayProtection?: CodexSessionsGrantReplayProtection;
  resolveImageAttachments?: (attachmentIds: readonly string[]) => Promise<string[]>;
  resolveTaskLocation?: CodexTaskLocationResolver;
  startTask?(
    request: CodexMachineTaskConnectorStartRequest,
    context: { generation: number; userId: string }
  ): Promise<CodexMachineTaskConnectorStartResult>;
  startTurn?(input: CodexStartTurnInput): Promise<{ turn: { id: string } }>;
  steerTurn?(input: CodexSteerTurnInput): Promise<{ turnId: string }>;
  transcript?: LocalCodexTranscriptSource;
  /** Required only by the signed connector wire wrapper. */
  verificationKey?: KeyLike;
}
