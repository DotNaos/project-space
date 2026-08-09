import type {
  TaskDeliveryProvider,
  TaskDeliveryProviderMutationResult,
  TaskDeliveryProviderObservation,
  TaskDeliveryProviderTarget
} from './contracts';
import { requestGitHubGraphQL } from '../github-graphql-client';
import { requestGitHub, resolveOAuthToken } from '../local-github-catalog';
import {
  authorizeGitHubTarget,
  hasGitHubReviewRequest,
  observeAuthorizedTarget,
  readPullRequestByNumber,
  readTargetPullRequest,
  type AuthorizedGitHubTarget,
  type GitHubApiPullRequest,
  type GitHubTaskDeliveryProviderDependencies,
  unavailableObservation
} from './github-provider-observation';
import { taskDeliveryReviewRequestFingerprint } from './review-fingerprint';

export type { GitHubTaskDeliveryProviderDependencies } from './github-provider-observation';

export interface CreateGitHubTaskDeliveryProviderOptions {
  backend: GitHubTaskDeliveryProviderDependencies['backend'];
  now?: () => string;
  requestGitHub?: GitHubTaskDeliveryProviderDependencies['requestGitHub'];
  requestGitHubGraphQL?: GitHubTaskDeliveryProviderDependencies['requestGitHubGraphQL'];
  resolveOAuthToken?: GitHubTaskDeliveryProviderDependencies['resolveOAuthToken'];
}

interface GitHubMergeResult {
  merged?: boolean;
  sha?: string | null;
}

interface GitHubIssueResult {
  state?: 'closed' | 'open';
}

function repoPath(fullName: string) {
  return fullName.split('/').map(encodeURIComponent).join('/');
}

function linkedBody(body: string | undefined, taskNumber: number) {
  return [
    body?.trim(),
    `Refs #${taskNumber}`,
    `<!-- project-space-task:${taskNumber} -->`
  ].filter(Boolean).join('\n\n');
}

function blocked(reason: string): TaskDeliveryProviderMutationResult {
  return { kind: 'blocked', reason };
}

function uncertain(reason = 'GitHub did not return a verifiable result.'):
TaskDeliveryProviderMutationResult {
  return { kind: 'uncertain', reason };
}

function fullCommit(value: string) {
  return /^[0-9a-f]{40}$/i.test(value);
}

async function changeDraftState(
  dependencies: GitHubTaskDeliveryProviderDependencies,
  context: AuthorizedGitHubTarget,
  pullRequest: GitHubApiPullRequest,
  draft: boolean
) {
  if (pullRequest.draft === draft) return;
  if (!pullRequest.node_id) throw new Error('Pull request identity unavailable.');
  if (draft) {
    await dependencies.requestGitHubGraphQL(
      context.token,
      `mutation ConvertPullRequestToDraft($id: ID!) {
        convertPullRequestToDraft(input: {pullRequestId: $id}) { pullRequest { id isDraft } }
      }`,
      { id: pullRequest.node_id }
    );
    return;
  }
  await dependencies.requestGitHubGraphQL(
    context.token,
    `mutation MarkPullRequestReadyForReview($id: ID!) {
      markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { id isDraft } }
    }`,
    { id: pullRequest.node_id }
  );
}

function matchesPresentation(
  pullRequest: GitHubApiPullRequest,
  title: string,
  body: string,
  draft: boolean,
  expectedHeadCommit: string
) {
  return pullRequest.title?.trim() === title.trim() &&
    pullRequest.body?.trim() === body.trim() &&
    pullRequest.draft === draft &&
    pullRequest.head?.sha?.toLowerCase() === expectedHeadCommit.toLowerCase();
}

async function reconcilePullRequestWrite(
  dependencies: GitHubTaskDeliveryProviderDependencies,
  context: AuthorizedGitHubTarget,
  input: Parameters<TaskDeliveryProvider['createOrUpdatePullRequest']>[0],
  body: string
) {
  try {
    const selected = await readTargetPullRequest(dependencies, context, input.target);
    if (selected.ambiguous) return blocked('pull_request_ambiguous');
    if (!selected.pullRequest || !matchesPresentation(
      selected.pullRequest, input.title, body, input.draft, input.expectedHeadCommit
    )) return uncertain();
    return {
      kind: 'confirmed' as const,
      observation: await observeAuthorizedTarget(
        dependencies, context, input.target, selected.pullRequest
      )
    };
  } catch {
    return uncertain();
  }
}

async function freshObservation(
  dependencies: GitHubTaskDeliveryProviderDependencies,
  target: Parameters<TaskDeliveryProvider['observe']>[0]
) {
  const authorized = await authorizeGitHubTarget(dependencies, target);
  return 'context' in authorized
    ? observeAuthorizedTarget(dependencies, authorized.context, target)
    : unavailableObservation(dependencies.now?.() ?? new Date().toISOString());
}

function reviewRequestMarker(commit: string, summary: string) {
  const digest = taskDeliveryReviewRequestFingerprint({ headCommit: commit, summary });
  return `<!-- project-space-review-request:${digest} -->`;
}

function confirmedMergedObservation(
  observation: TaskDeliveryProviderObservation,
  mergeCommit: string,
  observedAt: string
): TaskDeliveryProviderObservation {
  return {
    ...observation,
    mergeCommit: mergeCommit.toLowerCase(),
    observedAt,
    pullRequest: observation.pullRequest
      ? { ...observation.pullRequest, state: 'merged' }
      : undefined
  };
}

async function reconcileMergedPullRequest(
  dependencies: GitHubTaskDeliveryProviderDependencies,
  target: TaskDeliveryProviderTarget,
  pullRequestNumber: number,
  expectedHeadCommit: string
) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const authorized = await authorizeGitHubTarget(dependencies, target);
    if (!('context' in authorized)) continue;
    try {
      const pullRequest = await readPullRequestByNumber(
        dependencies, authorized.context, target, pullRequestNumber
      );
      const mergeCommit = pullRequest?.merge_commit_sha?.toLowerCase();
      if (pullRequest?.merged && pullRequest.head?.sha?.toLowerCase() === expectedHeadCommit &&
          mergeCommit && fullCommit(mergeCommit)) {
        return observeAuthorizedTarget(dependencies, authorized.context, target, pullRequest);
      }
    } catch {
      // A later bounded observation may see the provider's committed result.
    }
  }
  return undefined;
}

export function createGitHubTaskDeliveryProvider(
  options: CreateGitHubTaskDeliveryProviderOptions
): TaskDeliveryProvider {
  const dependencies: GitHubTaskDeliveryProviderDependencies = {
    backend: options.backend,
    now: options.now,
    requestGitHub: options.requestGitHub ?? requestGitHub,
    requestGitHubGraphQL: options.requestGitHubGraphQL ?? requestGitHubGraphQL,
    resolveOAuthToken: options.resolveOAuthToken ?? resolveOAuthToken
  };

  const observe: TaskDeliveryProvider['observe'] = async (target) => {
    const authorized = await authorizeGitHubTarget(dependencies, target);
    if (!('context' in authorized)) {
      return unavailableObservation(dependencies.now?.() ?? new Date().toISOString());
    }
    return observeAuthorizedTarget(dependencies, authorized.context, target);
  };

  return {
    observe,

    async createOrUpdatePullRequest(input) {
      if (!fullCommit(input.expectedHeadCommit)) return blocked('head_mismatch');
      const authorized = await authorizeGitHubTarget(dependencies, input.target);
      if (!('context' in authorized)) return blocked(authorized.blocked);
      const context = authorized.context;
      const initial = await observeAuthorizedTarget(dependencies, context, input.target);
      if (initial.sourceCommit !== input.expectedHeadCommit.toLowerCase()) {
        return blocked('head_mismatch');
      }
      let selected: Awaited<ReturnType<typeof readTargetPullRequest>>;
      try {
        selected = await readTargetPullRequest(dependencies, context, input.target);
      } catch {
        return uncertain();
      }
      if (selected.ambiguous) return blocked('pull_request_ambiguous');
      const body = linkedBody(input.body, context.taskNumber);
      const path = repoPath(context.repository.fullName);
      try {
        let pullRequest: GitHubApiPullRequest;
        if (selected.pullRequest) {
          if (selected.pullRequest.state !== 'open') return blocked('pull_request_missing');
          if (selected.pullRequest.head?.sha?.toLowerCase() !== input.expectedHeadCommit.toLowerCase()) {
            return blocked('head_mismatch');
          }
          pullRequest = await dependencies.requestGitHub<GitHubApiPullRequest>(
            `/repos/${path}/pulls/${selected.pullRequest.number}`,
            context.token,
            {
              body: JSON.stringify({ body, title: input.title.trim() }),
              headers: { 'Content-Type': 'application/json' },
              method: 'PATCH'
            }
          );
          await changeDraftState(dependencies, context, pullRequest, input.draft);
          pullRequest = { ...pullRequest, draft: input.draft };
        } else {
          pullRequest = await dependencies.requestGitHub<GitHubApiPullRequest>(
            `/repos/${path}/pulls`,
            context.token,
            {
              body: JSON.stringify({
                base: context.baseBranch,
                body,
                draft: input.draft,
                head: input.target.branch,
                title: input.title.trim()
              }),
              headers: { 'Content-Type': 'application/json' },
              method: 'POST'
            }
          );
        }
        return {
          kind: 'confirmed',
          observation: await observeAuthorizedTarget(dependencies, context, input.target, pullRequest)
        };
      } catch {
        return reconcilePullRequestWrite(dependencies, context, input, body);
      }
    },

    async requestReview(input) {
      if (!fullCommit(input.expectedHeadCommit)) return blocked('head_mismatch');
      const authorized = await authorizeGitHubTarget(dependencies, input.target);
      if (!('context' in authorized)) return blocked(authorized.blocked);
      const context = authorized.context;
      let pullRequest: GitHubApiPullRequest | undefined;
      try {
        pullRequest = await readPullRequestByNumber(
          dependencies, context, input.target, input.pullRequestNumber
        );
      } catch {
        return uncertain();
      }
      if (!pullRequest || pullRequest.state !== 'open') return blocked('pull_request_missing');
      if (pullRequest.head?.sha?.toLowerCase() !== input.expectedHeadCommit.toLowerCase()) {
        return blocked('head_mismatch');
      }
      const marker = reviewRequestMarker(input.expectedHeadCommit, input.summary);
      try {
        if (await hasGitHubReviewRequest(
          dependencies, context, pullRequest.number, input.expectedHeadCommit, marker
        )) {
          return {
            kind: 'confirmed',
            observation: await observeAuthorizedTarget(dependencies, context, input.target, pullRequest)
          };
        }
      } catch {
        return uncertain('GitHub review-request evidence is unavailable.');
      }
      try {
        await dependencies.requestGitHub(
          `/repos/${repoPath(context.repository.fullName)}/pulls/${pullRequest.number}/reviews`,
          context.token,
          {
            body: JSON.stringify({
              body: `${input.summary.trim()}\n\n${marker}`,
              commit_id: input.expectedHeadCommit,
              event: 'COMMENT'
            }),
            headers: { 'Content-Type': 'application/json' },
            method: 'POST'
          }
        );
        return {
          kind: 'confirmed',
          observation: await observeAuthorizedTarget(dependencies, context, input.target, pullRequest)
        };
      } catch {
        try {
          if (await hasGitHubReviewRequest(
            dependencies, context, pullRequest.number, input.expectedHeadCommit, marker
          )) {
            return {
              kind: 'confirmed',
              observation: await observeAuthorizedTarget(dependencies, context, input.target, pullRequest)
            };
          }
        } catch {
          // Preserve uncertainty without exposing the provider response.
        }
        return uncertain('GitHub did not confirm the review request.');
      }
    },

    async merge(input) {
      if (!fullCommit(input.expectedHeadCommit)) return blocked('head_mismatch');
      const authorized = await authorizeGitHubTarget(dependencies, input.target);
      if (!('context' in authorized)) return blocked(authorized.blocked);
      const context = authorized.context;
      let pullRequest: GitHubApiPullRequest | undefined;
      try {
        pullRequest = await readPullRequestByNumber(
          dependencies, context, input.target, input.pullRequestNumber
        );
      } catch {
        return uncertain();
      }
      if (!pullRequest) return blocked('pull_request_missing');
      const expected = input.expectedHeadCommit.toLowerCase();
      if (pullRequest.head?.sha?.toLowerCase() !== expected) return blocked('head_mismatch');
      const existingMergeCommit = pullRequest.merge_commit_sha?.toLowerCase();
      if (pullRequest.merged && existingMergeCommit && fullCommit(existingMergeCommit)) {
        return {
          kind: 'confirmed',
          observation: await observeAuthorizedTarget(dependencies, context, input.target, pullRequest)
        };
      }
      if (pullRequest.state !== 'open') return blocked('pull_request_missing');
      const observation = await observeAuthorizedTarget(dependencies, context, input.target, pullRequest);
      if (observation.pullRequest?.headCommit !== expected) return blocked('head_mismatch');
      if (observation.pullRequest.draft) return blocked('review_required');
      if (observation.checks.commit !== expected || observation.checks.state === 'unavailable') {
        return blocked('checks_unverified');
      }
      if (observation.checks.state === 'pending') return blocked('checks_pending');
      if (observation.checks.state === 'failing') return blocked('checks_failed');
      if (observation.review.commit !== expected || observation.review.state === 'unavailable' ||
          observation.review.unresolvedThreads === undefined) {
        return blocked('approval_stale');
      }
      if (observation.review.unresolvedThreads > 0) return blocked('unresolved_review');
      if (observation.review.state === 'changes_requested') return blocked('changes_requested');
      if (observation.review.state !== 'approved') return blocked('approval_required');
      try {
        const result = await dependencies.requestGitHub<GitHubMergeResult>(
          `/repos/${repoPath(context.repository.fullName)}/pulls/${pullRequest.number}/merge`,
          context.token,
          {
            body: JSON.stringify({ merge_method: input.method, sha: expected }),
            headers: { 'Content-Type': 'application/json' },
            method: 'PUT'
          }
        );
        const committed = result.sha?.toLowerCase();
        if (!result.merged) return blocked('merge_conflict');
        if (!committed || !fullCommit(committed)) return uncertain();
        return {
          kind: 'confirmed',
          observation: confirmedMergedObservation(
            observation,
            committed,
            dependencies.now?.() ?? new Date().toISOString()
          )
        };
      } catch {
        const reconciled = await reconcileMergedPullRequest(
          dependencies, input.target, pullRequest.number, expected
        );
        return reconciled?.pullRequest?.state === 'merged'
          ? { kind: 'confirmed', observation: reconciled }
          : uncertain('GitHub merge outcome is still uncertain.');
      }
    },

    async completeTask(input) {
      const authorized = await authorizeGitHubTarget(dependencies, input.target);
      if (!('context' in authorized)) return blocked(authorized.blocked);
      const context = authorized.context;
      const issue = context.details.issues.find((candidate) => candidate.number === context.taskNumber);
      if (issue?.state === 'closed') {
        return { kind: 'confirmed', observation: await observe(input.target) };
      }
      try {
        const result = await dependencies.requestGitHub<GitHubIssueResult>(
          `/repos/${repoPath(context.repository.fullName)}/issues/${context.taskNumber}`,
          context.token,
          {
            body: JSON.stringify({ state: 'closed' }),
            headers: { 'Content-Type': 'application/json' },
            method: 'PATCH'
          }
        );
        if (result.state !== 'closed') return uncertain('GitHub did not confirm Task completion.');
      } catch {
        // A lost response is reconciled by a fresh authorized read below.
      }
      const reconciled = await freshObservation(dependencies, input.target);
      return reconciled.taskState === 'completed'
        ? { kind: 'confirmed', observation: reconciled }
        : uncertain('GitHub Task completion outcome is still uncertain.');
    }
  };
}
