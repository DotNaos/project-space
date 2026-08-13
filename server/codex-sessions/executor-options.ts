import type { CodexSessionBrowserResult } from '../../src/shared/codex-sessions-api';
import type { CodexStartTurnInput, CodexSteerTurnInput } from './contracts';
import type { CodexSessionManager } from './index';
import type { CodexTaskLocationResolver } from './task-access-evidence';
import type { LocalCodexTranscriptSource } from './transcript-reader';

export interface CodexSessionsExecutorOptions {
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
  resolveImageAttachments?: (attachmentIds: readonly string[]) => Promise<string[]>;
  resolveTaskLocation?: CodexTaskLocationResolver;
  startTurn?(input: CodexStartTurnInput): Promise<{ turn: { id: string } }>;
  steerTurn?(input: CodexSteerTurnInput): Promise<{ turnId: string }>;
  transcript?: LocalCodexTranscriptSource;
}
