import type {
  CodexApprovalResponseInput,
  CodexInterruptTurnInput,
  CodexPermissionResponseInput,
  CodexResumeThreadInput,
  CodexStartTurnInput,
  CodexSteerTurnInput,
  CodexUpdateThreadSettingsInput,
  CodexUserInputResponseInput
} from './contracts';
import { CodexSessionManager } from './manager';
import { CodexOperationUncertainError } from './operation-ledger';
import type { LocalCodexTranscriptReader } from './transcript-reader';

const LOCAL_RUNTIME_EPOCH = 1;

export class LocalReviewCodexSessionManager extends CodexSessionManager {
  private threadName: string;

  constructor(private readonly local: {
    cwd: string;
    threadId: string;
    transcript: LocalCodexTranscriptReader;
    threadName?: string;
  }) {
    super();
    this.threadName = local.threadName ?? 'Local Codex task';
  }

  setThreadName(threadName: string) {
    const clean = threadName.trim();
    if (clean) this.threadName = clean;
  }

  override subscribe() {
    return () => false;
  }

  override async listLoadedThreads() {
    return { data: [this.local.threadId] };
  }

  override async listPermissionProfiles() {
    return { data: [], nextCursor: null };
  }

  override async readThread(threadId: string) {
    this.requireThread(threadId);
    const history = await this.local.transcript.read(threadId);
    return {
      thread: {
        cwd: this.local.cwd,
        id: threadId,
        name: this.threadName,
        status: { type: history.active ? 'active' as const : 'idle' as const },
        turns: [],
        updatedAt: Date.now()
      }
    };
  }

  override async readInspectionSnapshot(threadId: string) {
    const result = await this.readThread(threadId);
    return {
      loaded: { data: [threadId] },
      runtimeEpoch: LOCAL_RUNTIME_EPOCH,
      thread: result.thread
    };
  }

  override resumeThread(input: CodexResumeThreadInput) {
    return this.readThread(input.threadId);
  }

  override runtimeEpochIsCurrent(runtimeEpoch: number) {
    return runtimeEpoch === LOCAL_RUNTIME_EPOCH;
  }

  override async close() {}

  override startTurn(_input: CodexStartTurnInput): Promise<never> {
    return Promise.reject(unavailableMutation());
  }

  override steerTurn(_input: CodexSteerTurnInput): Promise<never> {
    return Promise.reject(unavailableMutation());
  }

  override interruptTurn(_input: CodexInterruptTurnInput): Promise<never> {
    return Promise.reject(unavailableMutation());
  }

  override updateThreadSettings(_input: CodexUpdateThreadSettingsInput): Promise<never> {
    return Promise.reject(unavailableMutation());
  }

  override respondToApproval(_input: CodexApprovalResponseInput): Promise<never> {
    return Promise.reject(unavailableMutation());
  }

  override respondToPermissions(_input: CodexPermissionResponseInput): Promise<never> {
    return Promise.reject(unavailableMutation());
  }

  override respondToUserInput(_input: CodexUserInputResponseInput): Promise<never> {
    return Promise.reject(unavailableMutation());
  }

  private requireThread(threadId: string) {
    if (threadId !== this.local.threadId) {
      throw new Error('The local Codex task does not match this review.');
    }
  }
}

function unavailableMutation() {
  return new CodexOperationUncertainError(
    'This Codex action must be routed through the owning Desktop task.'
  );
}
