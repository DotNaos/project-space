import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { PrototypeReviewLocalContext } from '../src/shared/prototype-review-local-api';
import type { CodexSessionsHttpHandler } from './codex-sessions-http';
import { CodexDesktopIpcClient } from './codex-sessions/desktop-ipc-client';
import { CodexSessionsConnectorExecutor } from './codex-sessions/connector-executor';
import { LocalReviewCodexSessionManager } from './codex-sessions/local-review-manager';
import { CodexSessionManager } from './codex-sessions/manager';
import { MemoryCodexSessionsStore } from './codex-sessions/memory-store';
import { CodexOperationUncertainError } from './codex-sessions/operation-ledger';
import { createCodexSessionsRuntime } from './codex-sessions/runtime';
import {
  CodexSessionsAccessError,
  type CodexSessionsTransport
} from './codex-sessions/service';
import type { LocalProjectSpaceBackend } from './local-project-space-backend';
import {
  PrototypeReviewCodexImageStore,
  type PrototypeReviewCodexImagesHandler
} from './prototype-review-codex-images';
import {
  createPrototypeReviewCodexModelsHandler,
  type PrototypeReviewCodexModelsHandler
} from './prototype-review-codex-models';
import { LocalCodexTranscriptReader } from './codex-sessions/transcript-reader';

const execFileAsync = promisify(execFile);
const CLAIM_TRANSIENT_FAILURE_GRACE_MS = 30_000;
const DESKTOP_MESSAGE_CONFIRMATION_TIMEOUT_MS = 30_000;

export interface PrototypeReviewLocalRuntime {
  close(): Promise<void>;
  codexImages: PrototypeReviewCodexImagesHandler;
  codexModels: PrototypeReviewCodexModelsHandler;
  codexSessions: CodexSessionsHttpHandler;
  readContext(
    expectedRepositoryFullName?: string,
    expectedPullRequestNumber?: number
  ): Promise<PrototypeReviewLocalContext>;
}

export async function createPrototypeReviewLocalRuntime(options: {
  backend: LocalProjectSpaceBackend;
  environment?: NodeJS.ProcessEnv;
  manager?: CodexSessionManager;
  readWorktreeClaim?: (repositoryRoot: string) => Promise<LocalWorktreeClaim | undefined>;
  repositoryRoot: string;
}): Promise<PrototypeReviewLocalRuntime> {
  const environment = options.environment ?? process.env;
  const registry = await options.backend.getConnectorProjectRegistry();
  const machineId = registry.connector.machineId;
  const machineName = registry.connector.machineName;
  const repositoryRoot = await realpath(options.repositoryRoot);
  const readWorktreeClaim =
    options.readWorktreeClaim ?? defaultReadWorktreeClaim;
  const initialClaim = await readWorktreeClaim(repositoryRoot);
  const threadId =
    cleanThreadId(environment.CODEX_THREAD_ID) ??
    cleanThreadId(initialClaim?.ownerThreadId);
  const transcript = new LocalCodexTranscriptReader({
    codexHome: environment.CODEX_HOME
  });
  const manager = options.manager ?? new LocalReviewCodexSessionManager({
    cwd: repositoryRoot,
    threadId: threadId ?? '__missing_local_thread__',
    transcript
  });
  let claimLoad: Promise<LocalWorktreeClaim | undefined> | undefined;
  let lastVerifiedClaim: LocalWorktreeClaim | undefined = initialClaim;
  let lastVerifiedClaimAt = initialClaim ? Date.now() : 0;
  const stableWorktreeClaim = async () => {
    if (claimLoad) return claimLoad;
    claimLoad = (async () => {
      const claim = await readWorktreeClaim(repositoryRoot);
      if (claim) {
        lastVerifiedClaim = claim;
        lastVerifiedClaimAt = Date.now();
        return claim;
      }
      return Date.now() - lastVerifiedClaimAt <= CLAIM_TRANSIENT_FAILURE_GRACE_MS
        ? lastVerifiedClaim
        : undefined;
    })();
    try {
      return await claimLoad;
    } finally {
      claimLoad = undefined;
    }
  };
  let authorizedIssue: number | undefined;
  const authorizeLocalReview = async () => {
    if (!threadId || !authorizedIssue) throw new CodexSessionsAccessError();
    const claim = await stableWorktreeClaim();
    if (
      !claim ||
      claim.issue !== authorizedIssue ||
      claim.ownerThreadId !== threadId ||
      claim.status !== 'ready' ||
      await realpath(claim.path) !== repositoryRoot
    ) {
      throw new CodexSessionsAccessError();
    }
  };
  const imageStoreKey = createHash('sha256')
    .update(repositoryRoot)
    .update('\0')
    .update(threadId ?? '__missing_local_thread__')
    .digest('hex');
  const images = new PrototypeReviewCodexImageStore(
    authorizeLocalReview,
    undefined,
    join(tmpdir(), 'project-space-prototype-review-images', imageStoreKey)
  );
  const codexModels = createPrototypeReviewCodexModelsHandler({
    authorize: authorizeLocalReview,
    cwd: repositoryRoot,
    machineId
  });
  const desktopIpc = new CodexDesktopIpcClient({
    codexHome: environment.CODEX_HOME
  });
  const executor = new CodexSessionsConnectorExecutor({
    expectedGeneration: 1,
    expectedMachineId: machineId,
    machineName,
    manager,
    resolveImageAttachments: (attachmentIds) => images.resolve(attachmentIds),
    async startTurn(input) {
      await desktopIpc.startTurn({
        cwd: repositoryRoot,
        effort: input.effort,
        localImagePaths: input.localImagePaths,
        model: input.model,
        operationId: input.operationId,
        prompt: input.prompt,
        serviceTier: input.serviceTier,
        threadId: input.threadId
      });
      const turnId = await transcript.waitForUserMessage(
        input.threadId,
        input.operationId,
        DESKTOP_MESSAGE_CONFIRMATION_TIMEOUT_MS
      );
      if (!turnId) {
        throw new CodexOperationUncertainError(
          'Codex Desktop did not persist the message in the owning task.'
        );
      }
      return { turn: { id: turnId } };
    },
    async steerTurn(input) {
      await desktopIpc.steerTurn({
        cwd: repositoryRoot,
        localImagePaths: input.localImagePaths,
        operationId: input.operationId,
        prompt: input.prompt,
        threadId: input.threadId
      });
      if (!await transcript.waitForUserMessage(
        input.threadId,
        input.operationId,
        DESKTOP_MESSAGE_CONFIRMATION_TIMEOUT_MS
      )) {
        throw new CodexOperationUncertainError(
          'Codex Desktop did not persist the message in the owning task.'
        );
      }
      return { turnId: input.expectedTurnId };
    },
    verificationKey: randomBytes(32)
  });
  const directTransport = executor.createLocalTransport(
    threadId ?? '__missing_local_thread__',
    transcript
  );
  const transport = guardTransport(directTransport, authorizeLocalReview);
  const runtime = createCodexSessionsRuntime({
    async authorize(_actor, requestedMachineId) {
      if (requestedMachineId !== machineId) {
        throw new Error('The local Codex machine does not match this server.');
      }
    },
    resolveContext: () => ({ userId: 'prototype-review-local-user' }),
    store: new MemoryCodexSessionsStore(),
    transport
  });

  return {
    async close() {
      executor.close();
      await images.close();
      await manager.close();
    },
    codexImages: images.handleRequest,
    codexModels,
    codexSessions: runtime.handleRequest,
    async readContext(expectedRepositoryFullName, expectedPullRequestNumber) {
      const checkedAt = new Date().toISOString();
      const checkout = await readCheckout(repositoryRoot);
      if (!checkout) {
        authorizedIssue = undefined;
        return unavailableContext(checkedAt, 'checkout-unavailable');
      }
      if (
        expectedRepositoryFullName &&
        checkout.repositoryFullName.toLowerCase() !== expectedRepositoryFullName.toLowerCase()
      ) {
        authorizedIssue = undefined;
        return unavailableContext(checkedAt, 'repository-mismatch');
      }
      if (!threadId) {
        authorizedIssue = undefined;
        return {
          checkedAt,
          checkout: { ...checkout, state: 'available' },
          codex: { reason: 'missing-thread', state: 'unavailable' }
        };
      }
      try {
        const task = await manager.readThread(threadId, false);
        const claim = await stableWorktreeClaim();
        if (
          task.thread.id !== threadId ||
          !claim ||
          claim.ownerThreadId !== threadId ||
          claim.status !== 'ready' ||
          await realpath(claim.path) !== repositoryRoot ||
          (
            expectedPullRequestNumber !== undefined &&
            claim.issue !== expectedPullRequestNumber
          )
        ) {
          authorizedIssue = undefined;
          return {
            checkedAt,
            checkout: { ...checkout, state: 'available' },
            codex: { reason: 'task-mismatch', state: 'unavailable' }
          };
        }
        authorizedIssue = expectedPullRequestNumber ?? claim.issue;
        if (!authorizedIssue) {
          authorizedIssue = undefined;
          return {
            checkedAt,
            checkout: { ...checkout, state: 'available' },
            codex: { reason: 'task-mismatch', state: 'unavailable' }
          };
        }
        return {
          checkedAt,
          checkout: { ...checkout, state: 'available' },
          codex: {
            machineId,
            machineName,
            state: 'available',
            threadId
          }
        };
      } catch {
        authorizedIssue = undefined;
        return {
          checkedAt,
          checkout: { ...checkout, state: 'available' },
          codex: { reason: 'codex-unavailable', state: 'unavailable' }
        };
      }
    }
  };
}

function guardTransport(
  transport: CodexSessionsTransport,
  authorize: () => Promise<void>
): CodexSessionsTransport {
  return {
    ...(transport.browser
      ? {
          browser: async (input) => {
            await authorize();
            return transport.browser!(input);
          }
        }
      : {}),
    async describeMachine(input) {
      await authorize();
      return transport.describeMachine(input);
    },
    async inspect(input) {
      await authorize();
      return transport.inspect(input);
    },
    async list(input) {
      await authorize();
      return transport.list(input);
    },
    async mutate(input) {
      await authorize();
      return transport.mutate(input);
    },
    async read(input) {
      await authorize();
      return transport.read(input);
    },
    ...(transport.stream
      ? {
          stream: async (input, emit, signal) => {
            await authorize();
            return transport.stream!(input, emit, signal);
          }
        }
      : {})
  };
}

interface LocalWorktreeClaim {
  issue?: number;
  ownerThreadId: string;
  path: string;
  status: string;
}

async function defaultReadWorktreeClaim(repositoryRoot: string) {
  try {
    const { stdout: ownerOutput } = await execFileAsync(
      'git',
      [
        '-C',
        repositoryRoot,
        'config',
        '--worktree',
        '--get',
        'project.codexThreadId'
      ],
      gitOptions
    );
    const ownerThreadId = cleanThreadId(String(ownerOutput));
    if (!ownerThreadId) return undefined;
    const { stdout } = await execFileAsync(
      join(repositoryRoot, 'bin', 'project'),
      ['worktree', 'check', '--format', 'json'],
      {
        ...gitOptions,
        cwd: repositoryRoot,
        env: { ...process.env, CODEX_THREAD_ID: ownerThreadId }
      }
    );
    const value: unknown = JSON.parse(String(stdout));
    if (!value || typeof value !== 'object') return undefined;
    const claim = value as Partial<LocalWorktreeClaim>;
    if (
      typeof claim.ownerThreadId !== 'string' ||
      typeof claim.path !== 'string' ||
      typeof claim.status !== 'string' ||
      (claim.issue !== undefined && (!Number.isSafeInteger(claim.issue) || claim.issue < 1))
    ) return undefined;
    return claim as LocalWorktreeClaim;
  } catch {
    return undefined;
  }
}

async function readCheckout(repositoryRoot: string) {
  try {
    const [{ stdout: headSha }, { stdout: remote }] = await Promise.all([
      execFileAsync('git', ['-C', repositoryRoot, 'rev-parse', 'HEAD'], gitOptions),
      execFileAsync('git', ['-C', repositoryRoot, 'remote', 'get-url', 'origin'], gitOptions)
    ]);
    const repositoryFullName = githubRepositoryFullName(String(remote).trim());
    const cleanHeadSha = String(headSha).trim();
    if (!repositoryFullName || !/^[0-9a-f]{40}$/i.test(cleanHeadSha)) return undefined;
    return { headSha: cleanHeadSha.toLowerCase(), repositoryFullName };
  } catch {
    return undefined;
  }
}

function githubRepositoryFullName(remote: string) {
  const match = remote.match(
    /^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/\s]+)\/([^/\s]+?)(?:\.git)?$/
  );
  return match ? `${match[1]}/${match[2]}` : undefined;
}

function cleanThreadId(value: string | undefined) {
  const threadId = value?.trim();
  return threadId && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(threadId)
    ? threadId
    : undefined;
}

function unavailableContext(
  checkedAt: string,
  reason: 'checkout-unavailable' | 'repository-mismatch'
): PrototypeReviewLocalContext {
  return {
    checkedAt,
    checkout: { reason, state: 'unavailable' },
    codex: { reason, state: 'unavailable' }
  };
}

const gitOptions = {
  encoding: 'utf8' as const,
  maxBuffer: 64 * 1024,
  timeout: 5_000
};
