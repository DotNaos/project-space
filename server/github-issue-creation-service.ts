import { createHash } from 'node:crypto';

import type {
  GitHubIssueCreateRequest,
  GitHubIssueCreationResult,
  GitHubIssueRecord
} from '../src/shared/project-space-api';
import {
  bodyWithGitHubIssueCreationMarker,
  gitHubIssueCreationMarker,
  stripGitHubIssueCreationMarker
} from '../src/shared/github-issue-creation-marker';
import type {
  GitHubIssueCreationOperationKey,
  GitHubIssueCreationOperationStore
} from './github-issue-creation-operation-store';

interface NormalizedGitHubIssueCreateRequest {
  body: string;
  fullName: string;
  labels: string[];
  operationId: string;
  title: string;
}

export interface GitHubIssueCreationRemote {
  create(request: NormalizedGitHubIssueCreateRequest): Promise<GitHubIssueRecord>;
  findByMarker(fullName: string, marker: string): Promise<GitHubIssueRecord[]>;
  isRetrySafeError(error: unknown): boolean;
}

interface CreateIdempotentGitHubIssueOptions {
  now?: () => number;
  remote: GitHubIssueCreationRemote;
  request: GitHubIssueCreateRequest;
  store: GitHubIssueCreationOperationStore;
  userId: string;
}

const uuidV4Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const pendingGraceMs = 15_000;

function normalizeRequest(
  request: GitHubIssueCreateRequest
): NormalizedGitHubIssueCreateRequest | null {
  if (!request || typeof request !== 'object') return null;
  const fullName = typeof request.fullName === 'string' ? request.fullName.trim() : '';
  const operationId = typeof request.operationId === 'string'
    ? request.operationId.trim().toLowerCase()
    : '';
  const title = typeof request.title === 'string' ? request.title.trim() : '';
  if (!fullName || !title || !uuidV4Pattern.test(operationId)) return null;
  return {
    body: typeof request.body === 'string' ? request.body.trim() : '',
    fullName,
    labels: Array.from(new Set(
      (Array.isArray(request.labels) ? request.labels : [])
        .filter((label): label is string => typeof label === 'string')
        .map((label) => label.trim())
        .filter(Boolean)
    )).sort(),
    operationId,
    title
  };
}

function fingerprint(request: NormalizedGitHubIssueCreateRequest) {
  return createHash('sha256').update(JSON.stringify({
    body: request.body,
    labels: request.labels,
    title: request.title
  })).digest('hex');
}

export {
  gitHubIssueCreationMarker,
  stripGitHubIssueCreationMarker
} from '../src/shared/github-issue-creation-marker';

function browserFacingIssue(issue: GitHubIssueRecord): GitHubIssueRecord {
  const body = stripGitHubIssueCreationMarker(issue.body ?? '');
  return { ...issue, body: body || undefined, labels: [...issue.labels] };
}

function retryable(message: string): GitHubIssueCreationResult {
  return { creationState: 'retryable', message, status: 'error' };
}

function uncertain(message: string): GitHubIssueCreationResult {
  return { creationState: 'uncertain', message, status: 'error' };
}

async function completeBestEffort(
  store: GitHubIssueCreationOperationStore,
  operation: GitHubIssueCreationOperationKey,
  issue: GitHubIssueRecord
) {
  try {
    await store.complete(operation, issue);
  } catch {
    // The marker still allows a later request to reconcile without another POST.
  }
}

async function reconcile(
  remote: GitHubIssueCreationRemote,
  store: GitHubIssueCreationOperationStore,
  operation: GitHubIssueCreationOperationKey
): Promise<GitHubIssueCreationResult> {
  let matches: GitHubIssueRecord[];
  try {
    matches = await remote.findByMarker(
      operation.repositoryFullName,
      gitHubIssueCreationMarker(operation.operationId)
    );
  } catch {
    return uncertain(
      'GitHub did not confirm whether the issue was created. Check GitHub again before retrying.'
    );
  }
  if (matches.length !== 1) {
    return uncertain(matches.length > 1
      ? 'More than one matching GitHub issue was found. Open GitHub and resolve the duplicate before continuing.'
      : 'GitHub still has not confirmed whether the issue was created. Check GitHub again before retrying.');
  }
  const issue = browserFacingIssue(matches[0]);
  await completeBestEffort(store, operation, issue);
  return { creationState: 'complete', issue, replayed: true, status: 'connected' };
}

async function preflight(
  remote: GitHubIssueCreationRemote,
  store: GitHubIssueCreationOperationStore,
  operation: GitHubIssueCreationOperationKey
) {
  let matches: GitHubIssueRecord[];
  try {
    matches = await remote.findByMarker(
      operation.repositoryFullName,
      gitHubIssueCreationMarker(operation.operationId)
    );
  } catch {
    return uncertain(
      'Project Space could not check GitHub for an earlier matching issue. Check GitHub again before retrying.'
    );
  }
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    return uncertain(
      'More than one matching GitHub issue was found. Open GitHub and resolve the duplicate before continuing.'
    );
  }
  const issue = browserFacingIssue(matches[0]);
  await completeBestEffort(store, operation, issue);
  return {
    creationState: 'complete',
    issue,
    replayed: true,
    status: 'connected'
  } satisfies GitHubIssueCreationResult;
}

export async function createIdempotentGitHubIssue({
  now = Date.now,
  remote,
  request,
  store,
  userId
}: CreateIdempotentGitHubIssueOptions): Promise<GitHubIssueCreationResult> {
  const normalized = normalizeRequest(request);
  if (!normalized) {
    return retryable('A repository, title, and secure issue operation identifier are required.');
  }
  const operation: GitHubIssueCreationOperationKey = {
    fingerprint: fingerprint(normalized),
    operationId: normalized.operationId,
    repositoryFullName: normalized.fullName,
    userId
  };

  let reservation;
  try {
    reservation = await store.reserve({
      ...operation,
      staleBefore: new Date(now() - pendingGraceMs).toISOString()
    });
  } catch {
    return uncertain(
      'Project Space could not verify the saved creation attempt. Nothing new was sent to GitHub; check GitHub again when storage is available.'
    );
  }

  if (reservation.kind === 'replayed') {
    return {
      creationState: 'complete',
      issue: browserFacingIssue(reservation.issue),
      replayed: true,
      status: 'connected'
    };
  }
  if (reservation.kind === 'conflict') {
    return uncertain(
      'This saved creation attempt belongs to a different draft. Check GitHub before starting another issue.'
    );
  }
  if (reservation.kind === 'pending') {
    return uncertain(
      'GitHub issue creation is still in progress. Check GitHub again before retrying.'
    );
  }
  if (reservation.kind === 'ambiguous') {
    return reconcile(remote, store, operation);
  }

  const existing = await preflight(remote, store, operation);
  if (existing) return existing;

  try {
    const issue = browserFacingIssue(await remote.create({
      ...normalized,
      body: bodyWithGitHubIssueCreationMarker(normalized.body, normalized.operationId)
    }));
    await completeBestEffort(store, operation, issue);
    return { creationState: 'complete', issue, status: 'connected' };
  } catch (error) {
    if (remote.isRetrySafeError(error)) {
      await store.markRetryable(operation).catch(() => undefined);
      return retryable(
        error instanceof Error ? error.message : 'GitHub rejected issue creation. Retry after correcting the problem.'
      );
    }
    await store.markAmbiguous(operation).catch(() => undefined);
    return reconcile(remote, store, operation);
  }
}
