import { ExternalLink } from 'lucide-react';
import { Text } from '@/app/dotnaos-ui';
import type {
  GitHubPullRequestRecord,
  PullRequestPreviewStatus
} from '@/shared/project-space-api';
import {
  previewSortPriority,
  type PullRequestPreviewInventoryState
} from './pull-request-preview-model';
import { PullRequestPreviewStatusView } from './pull-request-preview-status';
import { PullRequestPrototypeAction } from './pull-request-prototype-action';

function pullRequestEvidence(preview: PullRequestPreviewStatus): GitHubPullRequestRecord {
  return {
    headBranch: preview.headBranch,
    headSha: preview.currentHeadSha,
    linkedIssueNumbers: preview.linkedIssueNumbers,
    number: preview.pullRequestNumber,
    state: preview.pullRequestState ?? (preview.state === 'removed' ? 'closed' : 'open'),
    title: preview.pullRequestTitle ?? `Pull request #${preview.pullRequestNumber}`,
    updatedAt: preview.updatedAt,
    url: preview.pullRequestUrl ?? ''
  };
}

function visiblePreviews(previews: PullRequestPreviewStatus[]) {
  const sorted = [...previews].sort((left, right) =>
    previewSortPriority(left) - previewSortPriority(right) ||
    right.pullRequestNumber - left.pullRequestNumber
  );
  const active = sorted.filter((preview) => preview.state !== 'removed');
  const tombstones = sorted.filter((preview) => preview.state === 'removed').slice(0, 5);
  return [...active, ...tombstones].slice(0, 20);
}

export function PullRequestPreviewsSection({
  inventory,
  projectId,
  repositoryFullName
}: {
  inventory: PullRequestPreviewInventoryState;
  projectId: string;
  repositoryFullName: string;
}) {
  if (inventory.state === 'idle' || inventory.state === 'checking') {
    return <PreviewNotice>Checking the trusted Preview registry…</PreviewNotice>;
  }
  if (inventory.state === 'blocked') {
    return (
      <PreviewNotice tone={inventory.status === 'unauthorized' ? 'danger' : 'warning'}>
        {inventory.reason}
      </PreviewNotice>
    );
  }

  const previews = visiblePreviews(inventory.result.previews);
  if (!previews.length) {
    return <PreviewNotice>No pull request Previews were reported by a successful registry check.</PreviewNotice>;
  }

  return (
    <div className="divide-y divide-neutral-800/70 border-y border-neutral-800/70">
      {inventory.state === 'stale' ? (
        <div className="py-3 text-xs text-amber-200">{inventory.reason} Last verified results are shown.</div>
      ) : null}
      {previews.map((preview) => {
        const pullRequest = pullRequestEvidence(preview);
        return (
          <article key={`${preview.repositoryFullName}:${preview.pullRequestNumber}`} className="grid min-w-0 gap-3 py-4 sm:grid-cols-[minmax(0,1fr)_minmax(13rem,0.7fr)] sm:gap-5">
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <Text className="shrink-0 font-mono text-xs text-neutral-500">#{preview.pullRequestNumber}</Text>
                <Text className="min-w-0 truncate text-sm font-medium text-neutral-100">{pullRequest.title}</Text>
                {preview.pullRequestUrl ? (
                  <a aria-label={`Open pull request #${preview.pullRequestNumber} on GitHub`} className="shrink-0 text-neutral-500 transition hover:text-neutral-200" href={preview.pullRequestUrl} rel="noreferrer" target="_blank">
                    <ExternalLink className="size-3.5" />
                  </a>
                ) : null}
              </div>
              {preview.headBranch ? <Text className="mt-1 block truncate font-mono text-xs text-neutral-600">{preview.headBranch}</Text> : null}
            </div>
            <div className="grid min-w-0 gap-2">
              <PullRequestPreviewStatusView
                inventory={inventory}
                pullRequest={pullRequest}
                repositoryFullName={repositoryFullName}
                returnPath={pullRequest.linkedIssueNumbers?.[0]
                  ? `/projects/${encodeURIComponent(projectId)}/issues/${pullRequest.linkedIssueNumbers[0]}`
                  : `/projects/${encodeURIComponent(projectId)}/issues`}
              />
              <PullRequestPrototypeAction
                issueNumber={pullRequest.linkedIssueNumbers?.[0]}
                projectId={projectId}
                pullRequest={pullRequest}
                repositoryFullName={repositoryFullName}
              />
            </div>
          </article>
        );
      })}
    </div>
  );
}

function PreviewNotice({
  children,
  tone = 'muted'
}: {
  children: React.ReactNode;
  tone?: 'danger' | 'muted' | 'warning';
}) {
  const color = tone === 'danger'
    ? 'text-rose-200'
    : tone === 'warning'
      ? 'text-amber-200'
      : 'text-neutral-500';
  return <div className={`border-y border-neutral-800/70 px-1 py-3 text-sm ${color}`}>{children}</div>;
}
