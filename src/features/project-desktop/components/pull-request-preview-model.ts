import type {
  GitHubBranchRecord,
  GitHubIssueRecord,
  GitHubPullRequestRecord,
  PullRequestPreviewStatus,
  PullRequestPreviewStatusResult
} from '@/shared/project-space-api';
import { issueBranchesForIssue } from './issue-branch-model';

export type PullRequestPreviewInventoryState =
  | { state: 'idle' }
  | { state: 'checking' }
  | {
      reason: string;
      status: Exclude<PullRequestPreviewStatusResult['status'], 'available'>;
      state: 'blocked';
    }
  | { result: PullRequestPreviewStatusResult; state: 'ready' }
  | {
      lastSafeAt: string;
      reason: string;
      result: PullRequestPreviewStatusResult;
      state: 'stale';
    };

export interface PullRequestPreviewPresentation {
  detail: string;
  href?: string;
  label: string;
  state:
    | 'idle'
    | 'checking'
    | 'not-deployed'
    | 'progress'
    | 'current'
    | 'outdated'
    | 'failed'
    | 'cleanup'
    | 'removed'
    | 'unavailable'
    | 'stale';
  tone: 'danger' | 'muted' | 'success' | 'warning';
}

const fullSha = /^[0-9a-f]{40}$/i;

function sameBranch(left?: string, right?: string) {
  return Boolean(
    left && right &&
    left.trim().replace(/^refs\/heads\//, '').toLowerCase() ===
      right.trim().replace(/^refs\/heads\//, '').toLowerCase()
  );
}

function sameSha(left?: string, right?: string) {
  return Boolean(
    left && right && fullSha.test(left) && fullSha.test(right) &&
    left.toLowerCase() === right.toLowerCase()
  );
}

export function issueDevelopmentPullRequest({
  branches,
  issue,
  pullRequests
}: {
  branches: GitHubBranchRecord[];
  issue: GitHubIssueRecord;
  pullRequests: GitHubPullRequestRecord[];
}) {
  const linkedBranchNames = issueBranchesForIssue({ branches, issue }).map((branch) => branch.name);
  return pullRequests
    .filter((pullRequest) => (
      pullRequest.linkedIssueNumbers?.includes(issue.number) ||
      linkedBranchNames.some((branchName) => sameBranch(branchName, pullRequest.headBranch))
    ))
    .sort((left, right) => {
      const stateOrder = { open: 0, merged: 1, closed: 2 } as const;
      return stateOrder[left.state] - stateOrder[right.state] || right.number - left.number;
    })[0];
}

export function previewForPullRequest(
  result: PullRequestPreviewStatusResult,
  repositoryFullName: string,
  pullRequestNumber: number
) {
  return result.previews.find((preview) => (
    preview.repositoryFullName.toLowerCase() === repositoryFullName.toLowerCase() &&
    preview.pullRequestNumber === pullRequestNumber
  ));
}

function shortSha(value?: string) {
  return value && fullSha.test(value) ? value.slice(0, 7) : 'SHA unavailable';
}

function progressLabel(preview: PullRequestPreviewStatus) {
  const labels = {
    queued: 'Queued',
    validating: 'Validating',
    building: 'Building',
    'waiting-for-lock': 'Waiting for Preview lock',
    deploying: 'Deploying',
    verifying: 'Verifying'
  } as const;
  return labels[preview.state as keyof typeof labels];
}

function presentationForPreview(
  preview: PullRequestPreviewStatus,
  pullRequest: GitHubPullRequestRecord
): PullRequestPreviewPresentation {
  if (pullRequest.state !== 'open') {
    if (preview.state === 'removed') {
      return {
        detail: 'Runtime, route, network, and storage cleanup was confirmed.',
        label: 'Removed',
        state: 'removed',
        tone: 'success'
      };
    }
    if (preview.state === 'cleanup-failed') {
      return {
        detail: 'Automatic cleanup needs recovery. No current Preview link is exposed.',
        label: 'Cleanup failed',
        state: 'failed',
        tone: 'danger'
      };
    }
    return {
      detail: preview.state === 'deleting'
        ? 'Preview resources are being removed.'
        : 'The pull request is no longer open. Cleanup has not yet been confirmed.',
      label: preview.state === 'deleting' ? 'Deleting' : 'Cleanup pending',
      state: 'cleanup',
      tone: 'warning'
    };
  }

  const progress = progressLabel(preview);
  if (preview.state === 'blocked-capacity') {
    return {
      detail: 'Preview capacity is temporarily full. The exact-head request remains pending.',
      label: 'Waiting for capacity',
      state: 'progress',
      tone: 'warning'
    };
  }
  if (progress) {
    return {
      detail: `Preparing ${shortSha(preview.requestedSha)}. A link appears after verification.`,
      label: progress,
      state: 'progress',
      tone: 'warning'
    };
  }

  if (preview.state === 'cleanup-queued' || preview.state === 'deleting') {
    return {
      detail: 'Preview resources are scheduled for removal.',
      label: preview.state === 'deleting' ? 'Deleting' : 'Cleanup queued',
      state: 'cleanup',
      tone: 'warning'
    };
  }
  if (preview.state === 'removed') {
    return {
      detail: 'The previous Preview was removed with positive cleanup evidence.',
      label: 'Removed',
      state: 'removed',
      tone: 'muted'
    };
  }

  const currentHeadSha = pullRequest.headSha ?? preview.currentHeadSha;
  const runningAtCurrentHead = sameSha(preview.requestedSha, currentHeadSha) &&
    sameSha(preview.runningSha, currentHeadSha);
  const oldRunningPreview = Boolean(
    preview.liveUrl &&
    preview.runningSha &&
    currentHeadSha &&
    fullSha.test(preview.runningSha) &&
    fullSha.test(currentHeadSha) &&
    !sameSha(preview.runningSha, currentHeadSha)
  );

  if (preview.state === 'ready' && runningAtCurrentHead) {
    return preview.liveUrl ? {
      detail: `Verified at ${shortSha(currentHeadSha)}${preview.verifiedAt ? ` · ${new Date(preview.verifiedAt).toLocaleString()}` : ''}.`,
      href: preview.liveUrl,
      label: 'Ready',
      state: 'current',
      tone: 'success'
    } : {
      detail: 'The runtime is verified, but no safe public URL was reported.',
      label: 'Ready · URL unavailable',
      state: 'current',
      tone: 'warning'
    };
  }

  if ((preview.state === 'ready' || preview.state === 'update-failed') && oldRunningPreview) {
    return {
      detail: `Last working Preview ${shortSha(preview.runningSha)} is behind current head ${shortSha(currentHeadSha)}.`,
      href: preview.liveUrl,
      label: 'Outdated preview',
      state: 'outdated',
      tone: 'warning'
    };
  }

  if (
    preview.state === 'failed-initial' ||
    preview.state === 'update-failed' ||
    preview.state === 'cleanup-failed' ||
    preview.state === 'rejected' ||
    preview.state === 'superseded'
  ) {
    return {
      detail: preview.state === 'superseded'
        ? 'The PR head changed before this Preview could become current.'
        : 'The Preview did not reach a verified current runtime.',
      label: preview.state === 'superseded' ? 'Superseded' : 'Preview failed',
      state: 'failed',
      tone: preview.state === 'superseded' ? 'warning' : 'danger'
    };
  }

  return {
    detail: 'Preview evidence is incomplete, so no current link can be shown.',
    label: 'Preview unavailable',
    state: 'unavailable',
    tone: 'muted'
  };
}

export function pullRequestPreviewPresentation({
  inventory,
  pullRequest,
  repositoryFullName
}: {
  inventory: PullRequestPreviewInventoryState;
  pullRequest?: GitHubPullRequestRecord;
  repositoryFullName?: string;
}): PullRequestPreviewPresentation {
  if (!pullRequest || !repositoryFullName || inventory.state === 'idle') {
    return {
      detail: 'Create or link a pull request before checking its Preview.',
      label: 'Pull request required',
      state: 'idle',
      tone: 'muted'
    };
  }
  if (inventory.state === 'checking') {
    return {
      detail: 'Checking the trusted Preview registry…',
      label: 'Checking preview',
      state: 'checking',
      tone: 'muted'
    };
  }
  if (inventory.state === 'blocked') {
    return {
      detail: inventory.reason,
      label: inventory.status === 'unauthorized' ? 'Preview unauthorized' : 'Preview unavailable',
      state: 'unavailable',
      tone: inventory.status === 'unauthorized' ? 'danger' : 'warning'
    };
  }

  const preview = previewForPullRequest(
    inventory.result,
    repositoryFullName,
    pullRequest.number
  );
  if (inventory.state === 'stale') {
    if (!preview) {
      return {
        detail: 'The last successful check found no Preview, but current status is unavailable.',
        label: 'Preview status stale',
        state: 'stale',
        tone: 'warning'
      };
    }
    const previous = presentationForPreview(preview, pullRequest);
    return {
      ...previous,
      detail: `${previous.detail} Last successful check ${new Date(inventory.lastSafeAt).toLocaleString()}.`,
      label: previous.href ? 'Last verified preview' : 'Preview status stale',
      state: 'stale',
      tone: 'warning'
    };
  }
  if (!preview) {
    return pullRequest.state === 'open' ? {
      detail: 'A successful registry check found no Preview for this pull request.',
      label: 'Not deployed',
      state: 'not-deployed',
      tone: 'muted'
    } : {
      detail: 'No active Preview was reported. Confirmed cleanup requires a retained tombstone.',
      label: 'No active preview',
      state: 'cleanup',
      tone: 'muted'
    };
  }
  return presentationForPreview(preview, pullRequest);
}

export function previewSortPriority(preview: PullRequestPreviewStatus) {
  if (preview.state === 'ready' || progressLabel(preview)) return 0;
  if (preview.state === 'cleanup-failed' || preview.state === 'update-failed') return 1;
  if (preview.state === 'cleanup-queued' || preview.state === 'deleting') return 2;
  return preview.state === 'removed' ? 4 : 3;
}
