import { useEffect, useState } from 'react';
import { FileDiff, GitCommitHorizontal } from 'lucide-react';
import { projectSpaceClient } from '@/api/project-space-client';
import { Text, ToggleButton, ToggleButtonGroup } from '@/app/dotnaos-ui';
import type {
  ConnectorOverviewResult,
  GitHubCatalogRepository,
  GitHubBranchRecord,
  GitHubPullRequestRecord,
  GitStatusResult,
  ProjectSpaceRecord
} from '@/shared/project-space-api';
import type { MachineDetailTab } from '../hooks/use-project-desktop';
import { GitChangesPanel } from './git-changes-panel';
import { GitGraphPanel } from './git-graph-panel';

type GitWorkbenchView = 'history' | 'changes';

function useGitWorkbenchData({
  repositoryFullName,
  targetPath
}: {
  repositoryFullName?: string;
  targetPath: string;
}) {
  const [githubBranches, setGithubBranches] = useState<GitHubBranchRecord[]>([]);
  const [pullRequests, setPullRequests] = useState<GitHubPullRequestRecord[]>([]);
  const [status, setStatus] = useState<GitStatusResult>();
  const [message, setMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  async function refresh() {
    if (!targetPath) {
      setStatus(undefined);
      setMessage('No workspace target is selected.');
      return;
    }

    setIsLoading(true);
    setMessage('');

    try {
      const [nextStatus, details] = await Promise.all([
        projectSpaceClient.getGitStatus(targetPath),
        repositoryFullName
          ? projectSpaceClient.getGitHubRepositoryDetails(repositoryFullName).catch(() => undefined)
          : Promise.resolve(undefined)
      ]);

      setStatus(nextStatus);
      setGithubBranches(details?.branches ?? []);
      setPullRequests(details?.pullRequests ?? []);
      setMessage(details?.message ?? '');
    } catch (error) {
      setStatus(undefined);
      setMessage(error instanceof Error ? error.message : 'Could not load git state.');
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, [repositoryFullName, targetPath]);

  return {
    githubBranches,
    isLoading,
    message,
    pullRequests,
    refresh,
    status
  };
}

export function GitWorkbenchPanel({
  connectorOverview,
  onOpenMachine,
  project,
  projects,
  repository,
  repositoryFullName,
  targetPath
}: {
  connectorOverview?: ConnectorOverviewResult;
  onOpenMachine?(machineId: string, tab?: MachineDetailTab): void;
  project?: ProjectSpaceRecord;
  projects?: ProjectSpaceRecord[];
  repository?: GitHubCatalogRepository;
  repositoryFullName?: string;
  targetPath: string;
}) {
  const [view, setView] = useState<GitWorkbenchView>('history');
  const data = useGitWorkbenchData({ repositoryFullName, targetPath });
  const changeCount = data.status?.entries.length ?? 0;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-3">
      <div className="flex shrink-0 items-center justify-between gap-3">
        <ToggleButtonGroup
          aria-label="Git view"
          selectedKeys={new Set([view])}
          onSelectionChange={(keys) => {
            const nextView = Array.from(keys)[0];

            if (nextView === 'history' || nextView === 'changes') {
              setView(nextView);
            }
          }}
          className="rounded-lg bg-neutral-900/70 p-1"
        >
          <ToggleButton id="history" className="h-8 gap-1.5 rounded-md px-2.5 text-xs">
            <GitCommitHorizontal className="size-3.5" />
            History
          </ToggleButton>
          <ToggleButton id="changes" className="h-8 gap-1.5 rounded-md px-2.5 text-xs">
            <FileDiff className="size-3.5" />
            Changes
            {changeCount > 0 ? (
              <span className="rounded-full bg-neutral-700/80 px-1.5 py-px font-mono text-[10px] text-neutral-200">
                {changeCount}
              </span>
            ) : null}
          </ToggleButton>
        </ToggleButtonGroup>
        <Text className="hidden min-w-0 truncate text-xs text-neutral-600 sm:block">
          {data.status?.isRepository
            ? `${data.status.branchName}${data.status.upstream ? ` → ${data.status.upstream}` : ''} · ${data.status.repositoryRoot}`
            : data.message || 'Git status'}
        </Text>
      </div>

      <div className="min-h-0 flex-1">
        {view === 'history' ? (
          <GitGraphPanel
            connectorOverview={connectorOverview}
            githubBranches={data.githubBranches}
            onOpenMachine={onOpenMachine}
            onRefreshRepositoryDetails={data.refresh}
            project={project}
            projects={projects}
            pullRequests={data.pullRequests}
            repository={repository}
            repositoryFullName={repositoryFullName}
            targetPath={targetPath}
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
