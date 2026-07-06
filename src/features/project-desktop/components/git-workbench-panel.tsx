import { useEffect, useState } from 'react';
import { FileDiff, GitBranch, GitCommitHorizontal } from 'lucide-react';
import { projectSpaceClient } from '@/api/project-space-client';
import { Text, ToggleButton, ToggleButtonGroup } from '@/app/dotnaos-ui';
import type {
  GitHistoryCommit,
  GitHubBranchRecord,
  GitHubIssueRecord,
  GitHubPullRequestRecord,
  GitStatusResult
} from '@/shared/project-space-api';
import { GitBranchesPanel } from './git-branches-panel';
import { GitChangesPanel } from './git-changes-panel';
import { GitGraphPanel } from './git-graph-panel';

type GitWorkbenchView = 'graph' | 'branches' | 'changes';

const historyLimit = 300;

function useGitWorkbenchData({
  repositoryFullName,
  targetPath
}: {
  repositoryFullName?: string;
  targetPath: string;
}) {
  const [commits, setCommits] = useState<GitHistoryCommit[]>([]);
  const [githubBranches, setGithubBranches] = useState<GitHubBranchRecord[]>([]);
  const [issues, setIssues] = useState<GitHubIssueRecord[]>([]);
  const [pullRequests, setPullRequests] = useState<GitHubPullRequestRecord[]>([]);
  const [status, setStatus] = useState<GitStatusResult>();
  const [message, setMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  async function refresh() {
    if (!targetPath) {
      setCommits([]);
      setStatus(undefined);
      setMessage('No workspace target is selected.');
      return;
    }

    setIsLoading(true);
    setMessage('');

    try {
      const [history, nextStatus, details] = await Promise.all([
        projectSpaceClient.getGitHistory({
          cwd: targetPath,
          limit: historyLimit,
          repositoryFullName
        }),
        projectSpaceClient.getGitStatus(targetPath),
        repositoryFullName
          ? projectSpaceClient.getGitHubRepositoryDetails(repositoryFullName).catch(() => undefined)
          : Promise.resolve(undefined)
      ]);

      setCommits(history.isRepository ? history.commits : []);
      setStatus(nextStatus);
      setGithubBranches(details?.branches ?? []);
      setIssues(details?.issues ?? []);
      setPullRequests(details?.pullRequests ?? []);
      setMessage(history.message ?? details?.message ?? '');
    } catch (error) {
      setCommits([]);
      setMessage(error instanceof Error ? error.message : 'Could not load git state.');
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, [repositoryFullName, targetPath]);

  return {
    commits,
    githubBranches,
    isLoading,
    issues,
    message,
    pullRequests,
    refresh,
    status
  };
}

export function GitWorkbenchPanel({
  repositoryFullName,
  targetPath
}: {
  repositoryFullName?: string;
  targetPath: string;
}) {
  const [view, setView] = useState<GitWorkbenchView>('graph');
  const data = useGitWorkbenchData({ repositoryFullName, targetPath });

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-3">
      <div className="flex shrink-0 items-center justify-between gap-3">
        <ToggleButtonGroup
          aria-label="Git view"
          selectedKeys={new Set([view])}
          onSelectionChange={(keys) => {
            const nextView = Array.from(keys)[0];

            if (nextView === 'graph' || nextView === 'branches' || nextView === 'changes') {
              setView(nextView);
            }
          }}
          className="rounded-lg bg-neutral-900/70 p-1"
        >
          <ToggleButton id="graph" className="h-8 gap-1.5 rounded-md px-2.5 text-xs">
            <GitCommitHorizontal className="size-3.5" />
            Graph
          </ToggleButton>
          <ToggleButton id="branches" className="h-8 gap-1.5 rounded-md px-2.5 text-xs">
            <GitBranch className="size-3.5" />
            Branches
          </ToggleButton>
          <ToggleButton id="changes" className="h-8 gap-1.5 rounded-md px-2.5 text-xs">
            <FileDiff className="size-3.5" />
            Changes
          </ToggleButton>
        </ToggleButtonGroup>
        <Text className="hidden min-w-0 truncate text-xs text-neutral-600 sm:block">
          {data.status?.isRepository
            ? `${data.status.repositoryRoot}`
            : data.message || 'Git status'}
        </Text>
      </div>

      <div className="min-h-0 flex-1">
        {view === 'graph' ? (
          <GitGraphPanel repositoryFullName={repositoryFullName} targetPath={targetPath} />
        ) : null}
        {view === 'branches' ? (
          <GitBranchesPanel
            commits={data.commits}
            githubBranches={data.githubBranches}
            isLoading={data.isLoading}
            issues={data.issues}
            message={data.message}
            pullRequests={data.pullRequests}
            refresh={data.refresh}
            repositoryFullName={repositoryFullName}
            status={data.status}
          />
        ) : null}
        {view === 'changes' ? (
          <GitChangesPanel
            isLoading={data.isLoading}
            refresh={data.refresh}
            status={data.status}
            targetPath={targetPath}
          />
        ) : null}
      </div>
    </div>
  );
}
