import { ExternalLink } from 'lucide-react';
import { Text } from '@/app/dotnaos-ui';
import type { GitHubPullRequestRecord } from '@/shared/project-space-api';
import {
  pullRequestPreviewPresentation,
  type PullRequestPreviewInventoryState
} from './pull-request-preview-model';
import { PublicDeploymentLink, visibleDeploymentUrl } from './public-deployment-link';
import { StatusChip, StatusIcon } from './deployment-status-ui';

export function PullRequestPreviewStatusView({
  inventory,
  pullRequest,
  repositoryFullName
}: {
  inventory: PullRequestPreviewInventoryState;
  pullRequest?: GitHubPullRequestRecord;
  repositoryFullName?: string;
}) {
  const presentation = pullRequestPreviewPresentation({
    inventory,
    pullRequest,
    repositoryFullName
  });
  const active = presentation.state === 'checking' || presentation.state === 'progress';

  return (
    <div className="grid min-w-0 gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <StatusIcon active={active} tone={presentation.tone} />
        <StatusChip tone={presentation.tone}>{presentation.label}</StatusChip>
      </div>
      <Text className="text-xs leading-5 text-neutral-500">{presentation.detail}</Text>
      {presentation.href ? (
        <div className="grid min-w-0 gap-1.5">
          <PublicDeploymentLink
            className="min-h-10 w-full justify-center rounded-lg border border-sky-400/25 bg-sky-400/10 px-3 text-sm no-underline hover:bg-sky-400/15 hover:no-underline"
            environmentName={`Pull request #${pullRequest?.number ?? ''} Preview`}
            href={presentation.href}
            linkLabel={presentation.state === 'outdated' || presentation.state === 'stale'
              ? 'Open last working preview'
              : 'Open preview'}
          />
          <Text className="flex min-w-0 items-center gap-1 text-[10px] text-neutral-600">
            <ExternalLink className="size-3 shrink-0" />
            <span className="truncate">{visibleDeploymentUrl(presentation.href)}</span>
          </Text>
        </div>
      ) : null}
    </div>
  );
}
