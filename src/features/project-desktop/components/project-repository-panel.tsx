import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  ExternalLink,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  History,
  Laptop,
  ListFilter,
  LoaderCircle,
  TriangleAlert
} from 'lucide-react';
import { projectSpaceClient } from '@/api/project-space-client';
import {
  Button,
  Chip,
  SearchField,
  SearchFieldClearButton,
  SearchFieldGroup,
  SearchFieldInput,
  SearchFieldSearchIcon,
  Text
} from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import type {
  ExplorerTarget,
  GitHubCatalogRepository,
  GitHubRepositoryDetailsResult,
  ProjectSpaceRecord,
  ProjectWorktreeDiscoveryState,
  ProjectWorktreeRecord
} from '@/shared/project-space-api';
import type { GitHistoryFocus } from './git-focused-history';
import {
  filterRepositoryBranches,
  repositoryBranchViewModels,
  type RepositoryBranchFilter,
  type RepositoryBranchViewModel
} from './project-repository-model';
import { ProjectWorkspacesPanel } from './project-workspaces-panel';

const filters: Array<{
  id: RepositoryBranchFilter;
  icon: typeof ListFilter;
  label: string;
}> = [
  { id: 'all', icon: ListFilter, label: 'All' },
  { id: 'pull-request', icon: GitPullRequest, label: 'Pull request' },
  { id: 'checked-out', icon: Laptop, label: 'Checked out' },
  { id: 'attention', icon: TriangleAlert, label: 'Needs attention' }
];

function PullRequestChip({ entry }: { entry: RepositoryBranchViewModel }) {
  const pullRequest = entry.pullRequest;
  if (!pullRequest) return null;
  const merged = pullRequest.state === 'merged';
  const Icon = merged ? GitMerge : GitPullRequest;

  return (
    <Chip
      size="sm"
      variant="tertiary"
      className={cn(
        'shrink-0 gap-1 border-0',
        merged
          ? 'bg-violet-500/10 text-violet-300'
          : pullRequest.isDraft
            ? 'bg-neutral-800 text-neutral-400'
            : pullRequest.state === 'open'
              ? 'bg-emerald-500/10 text-emerald-300'
              : 'bg-neutral-800 text-neutral-500'
      )}
    >
      <Icon className="size-3" />
      #{pullRequest.number}
    </Chip>
  );
}

function CheckoutChip({ entry }: { entry: RepositoryBranchViewModel }) {
  if (entry.worktrees.length === 0) return null;

  return (
    <Chip size="sm" variant="tertiary" className="shrink-0 gap-1 border-0 bg-neutral-900 text-neutral-400">
      <Laptop className="size-3" />
      {entry.worktrees.length === 1 ? 'Checked out' : `${entry.worktrees.length} checkouts`}
    </Chip>
  );
}

export function ProjectRepositoryPanel({
  onOpenHistory,
  onRefreshWorktrees,
  onSelectWorkspace,
  onSelectWorktree,
  project,
  repository,
  selectedExplorerTarget,
  selectedMachineId,
  worktreeDiscovery,
  worktrees
}: {
  onOpenHistory(focus: Omit<GitHistoryFocus, 'requestId'>): void;
  onRefreshWorktrees(): Promise<ProjectWorktreeRecord[]>;
  onSelectWorkspace(): void;
  onSelectWorktree(worktreeId: string): void;
  project: ProjectSpaceRecord;
  repository?: GitHubCatalogRepository;
  selectedExplorerTarget: ExplorerTarget;
  selectedMachineId: string;
  worktreeDiscovery: ProjectWorktreeDiscoveryState;
  worktrees: ProjectWorktreeRecord[];
}) {
  const [details, setDetails] = useState<GitHubRepositoryDetailsResult>();
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<RepositoryBranchFilter>('all');
  const [isLoading, setIsLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedBranchName, setSelectedBranchName] = useState('');
  const repositoryFullName = repository?.fullName ?? project.github?.fullName;
  const defaultBranch =
    repository?.defaultBranch ?? project.github?.defaultBranch ?? project.gitStatus?.branchName ?? 'main';

  useEffect(() => {
    if (!repositoryFullName) {
      setDetails(undefined);
      setError('No GitHub repository is linked to this project.');
      return;
    }

    let canceled = false;
    setIsLoading(true);
    setError('');
    projectSpaceClient
      .getGitHubRepositoryDetails(repositoryFullName)
      .then((result) => {
        if (canceled) return;
        setDetails(result);
        if (result.status !== 'connected') {
          setError(result.message ?? 'Repository data is unavailable.');
        }
      })
      .catch((requestError) => {
        if (!canceled) {
          setError(requestError instanceof Error ? requestError.message : 'Could not load branches.');
        }
      })
      .finally(() => {
        if (!canceled) setIsLoading(false);
      });

    return () => {
      canceled = true;
    };
  }, [repositoryFullName]);

  const branches = useMemo(
    () => repositoryBranchViewModels({
      branches: details?.branches ?? [],
      pullRequests: details?.pullRequests ?? [],
      worktrees
    }),
    [details?.branches, details?.pullRequests, worktrees]
  );
  const visibleBranches = useMemo(
    () => filterRepositoryBranches({ branches, filter, query }),
    [branches, filter, query]
  );
  const selectedBranch = branches.find((entry) => entry.branch.name === selectedBranchName);

  function selectBranch(entry: RepositoryBranchViewModel) {
    const selectedWorktree = entry.worktrees[0];
    if (selectedWorktree) onSelectWorktree(selectedWorktree.id);
    else if (entry.branch.isDefault) onSelectWorkspace();
    setSelectedBranchName(entry.branch.name);
  }

  if (selectedBranch) {
    return (
      <div className="flex min-h-0 flex-col gap-5">
        <header className="shrink-0 border-b border-neutral-800/70 pb-4">
          <Button size="sm" variant="ghost" onPress={() => setSelectedBranchName('')}>
            <ArrowLeft className="size-4" />
            Repository
          </Button>
          <div className="mt-4 flex min-w-0 flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <GitBranch className="size-5 shrink-0 text-neutral-500" />
                <Text className="truncate text-xl font-semibold text-neutral-50">
                  {selectedBranch.branch.name}
                </Text>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {selectedBranch.branch.commitSha ? (
                  <span className="inline-flex items-center gap-1 font-mono text-xs text-neutral-500">
                    <GitCommitHorizontal className="size-3.5" />
                    {selectedBranch.branch.commitSha.slice(0, 8)}
                  </span>
                ) : null}
                <PullRequestChip entry={selectedBranch} />
                <CheckoutChip entry={selectedBranch} />
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              {selectedBranch.branch.url ? (
                <a
                  className="inline-flex min-h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-medium text-neutral-300 transition hover:bg-neutral-900 hover:text-neutral-100"
                  href={selectedBranch.branch.url}
                  rel="noreferrer"
                  target="_blank"
                >
                  GitHub <ExternalLink className="size-3.5" />
                </a>
              ) : null}
              <Button
                size="sm"
                variant="secondary"
                onPress={() => onOpenHistory({ defaultBranch, headBranch: selectedBranch.branch.name })}
              >
                <History className="size-4" /> History
              </Button>
            </div>
          </div>
        </header>

        <ProjectWorkspacesPanel
          onRefreshWorktrees={onRefreshWorktrees}
          onSelectWorkspace={onSelectWorkspace}
          onSelectWorktree={onSelectWorktree}
          project={project}
          repository={repository}
          selectedExplorerTarget={selectedExplorerTarget}
          selectedMachineId={selectedMachineId}
          worktreeDiscovery={worktreeDiscovery}
          worktrees={worktrees}
        />
      </div>
    );
  }

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-neutral-800/70 pb-4">
        <Text className="text-2xl font-semibold text-neutral-50">Repository</Text>
        <Text className="mt-1 block text-sm text-neutral-500">
          Choose a branch to see its history, pull request, and machine checkouts.
        </Text>
      </header>

      <div className="flex shrink-0 flex-col gap-3 border-b border-neutral-800/70 py-4 lg:flex-row lg:items-center lg:justify-between">
        <SearchField className="w-full lg:max-w-sm" onChange={setQuery} value={query}>
          <SearchFieldGroup className="h-10 rounded-full bg-neutral-900/80">
            <SearchFieldSearchIcon />
            <SearchFieldInput placeholder="Search branches, PRs, or checkouts" />
            <SearchFieldClearButton />
          </SearchFieldGroup>
        </SearchField>
        <div className="flex min-w-0 gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {filters.map(({ id, icon: Icon, label }) => (
            <Button
              key={id}
              size="sm"
              variant={filter === id ? 'secondary' : 'ghost'}
              className="shrink-0 rounded-full"
              onPress={() => setFilter(id)}
            >
              <Icon className="size-3.5" />
              {label}
            </Button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {isLoading ? (
          <div className="flex min-h-48 items-center justify-center gap-2 text-neutral-500">
            <LoaderCircle className="size-4 animate-spin" />
            <Text className="text-sm">Loading branches…</Text>
          </div>
        ) : error && branches.length === 0 ? (
          <div className="grid min-h-48 place-items-center px-6 text-center">
            <Text className="max-w-md text-sm text-red-300/80">{error}</Text>
          </div>
        ) : visibleBranches.length === 0 ? (
          <div className="grid min-h-48 place-items-center px-6 text-center">
            <Text className="text-sm text-neutral-500">No branches match this search and filter.</Text>
          </div>
        ) : (
          <div className="divide-y divide-neutral-800/70">
            {visibleBranches.map((entry) => (
              <button
                key={entry.branch.name}
                type="button"
                className="group grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-1 py-3 text-left transition hover:bg-neutral-900/35"
                onClick={() => selectBranch(entry)}
              >
                <span className="flex min-w-0 items-center gap-3">
                  <span className="grid size-8 shrink-0 place-items-center rounded-full bg-neutral-900 text-neutral-500">
                    <GitBranch className="size-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-neutral-200">
                      {entry.branch.name}
                    </span>
                    <span className="mt-1 block truncate font-mono text-[11px] text-neutral-600">
                      {entry.branch.isDefault ? 'Default branch' : entry.branch.commitSha?.slice(0, 8) ?? 'Branch'}
                    </span>
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <PullRequestChip entry={entry} />
                  <CheckoutChip entry={entry} />
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      <footer className="shrink-0 border-t border-neutral-800/70 py-3 text-xs text-neutral-600">
        {visibleBranches.length} of {branches.length} branches
      </footer>
    </section>
  );
}
