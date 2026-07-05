import { useEffect, useMemo, useState } from 'react';
import {
  GitBranch,
  GitBranchPlus,
  ListChecks,
  Play,
  Rocket,
  Server,
  ShieldCheck
} from 'lucide-react';
import { projectSpaceClient } from '@/api/project-space-client';
import { Button, Chip, Surface, Text } from '@/app/dotnaos-ui';
import type {
  ConnectorOverviewResult,
  GitHubCatalogRepository,
  GitHubIssueRecord,
  GitHubRepositoryDetailsResult,
  ProjectSpaceRecord
} from '@/shared/project-space-api';
import { GitHubMark } from './github-mark';
import { repositoryDetailsFallback } from './project-main-model';

function useRepositoryDetails(repository?: GitHubCatalogRepository) {
  const [details, setDetails] = useState<GitHubRepositoryDetailsResult>();
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!repository) {
      setDetails(undefined);
      setError('');
      setIsLoading(false);
      return;
    }

    let canceled = false;

    setError('');
    setIsLoading(true);
    projectSpaceClient
      .getGitHubRepositoryDetails(repository.fullName)
      .then((nextDetails) => {
        if (!canceled) {
          setDetails(nextDetails);
        }
      })
      .catch((requestError) => {
        if (!canceled) {
          setError(
            requestError instanceof Error
              ? requestError.message
              : 'Could not load repository details.'
          );
        }
      })
      .finally(() => {
        if (!canceled) {
          setIsLoading(false);
        }
      });

    return () => {
      canceled = true;
    };
  }, [repository]);

  return {
    details: details ?? repositoryDetailsFallback(repository ? 'connected' : 'error'),
    error,
    isLoading
  };
}

function IssueRow({
  issue,
  onOpenIssue
}: {
  issue: GitHubIssueRecord;
  onOpenIssue(issueNumber: number): void;
}) {
  return (
    <div className="group/issue-row flex min-w-0 items-start gap-2 rounded-lg transition hover:bg-neutral-900/60">
      <button
        type="button"
        onClick={() => onOpenIssue(issue.number)}
        className="flex min-w-0 flex-1 items-start gap-3 px-2 py-2.5 text-left"
      >
        <Text className="shrink-0 text-xs text-neutral-500">#{issue.number}</Text>
        <span className="min-w-0 flex-1">
          <Text className="block truncate text-sm font-medium text-neutral-100">
            {issue.title}
          </Text>
          <Text className="block truncate text-xs text-neutral-500">
            {issue.author ? `Opened by ${issue.author}` : 'Open issue'}
            {issue.updatedAt ? ` · updated ${new Date(issue.updatedAt).toLocaleDateString()}` : ''}
          </Text>
        </span>
      </button>
      <a
        href={issue.url}
        target="_blank"
        rel="noreferrer"
        aria-label={`Open issue #${issue.number} on GitHub`}
        title="Open on GitHub"
        className="mr-1 mt-1.5 flex size-7 shrink-0 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-800 hover:text-neutral-100"
      >
        <GitHubMark className="size-3.5" />
      </a>
    </div>
  );
}

function StatLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 text-sm">
      <Text className="text-neutral-500">{label}</Text>
      <Text className="truncate text-neutral-200">{value}</Text>
    </div>
  );
}

export function ProjectOverviewWorkbench({
  connectorOverview,
  launcherError,
  onOpenIssue,
  project,
  repository,
  selectedTargetPath
}: {
  connectorOverview: ConnectorOverviewResult;
  launcherError: string;
  onOpenIssue(issueNumber: number): void;
  project: ProjectSpaceRecord;
  repository?: GitHubCatalogRepository;
  selectedTargetPath: string;
}) {
  const { details, error, isLoading } = useRepositoryDetails(repository);
  const localMachine = connectorOverview.machines.find(
    (machine) => machine.connector.status === 'local'
  );
  const priorityIssues = useMemo(() => details.issues.slice(0, 6), [details.issues]);
  const message =
    launcherError ||
    error ||
    details.message ||
    (isLoading ? 'Loading repository details...' : '');

  return (
    <div className="grid min-h-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.8fr)]">
      <section className="min-w-0">
        {message ? (
          <Surface
            variant="tertiary"
            className="mb-3 rounded-lg border border-amber-400/20 bg-amber-500/8 px-4 py-3 text-sm text-amber-300"
          >
            {message}
          </Surface>
        ) : null}

        <Surface
          variant="tertiary"
          className="min-w-0 rounded-lg border border-neutral-800 bg-neutral-950/45 p-4"
        >
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <ListChecks className="size-4 text-neutral-400" />
              <Text className="text-sm font-semibold text-neutral-100">Priority queue</Text>
            </div>
            <Chip size="sm" variant="secondary">
              {details.issues.length} open
            </Chip>
          </div>

          {repository ? (
            priorityIssues.length > 0 ? (
              <div className="flex max-h-[32rem] flex-col overflow-auto">
                {priorityIssues.map((issue) => (
                  <IssueRow key={issue.number} issue={issue} onOpenIssue={onOpenIssue} />
                ))}
              </div>
            ) : (
              <Text className="text-sm text-neutral-500">
                {message || 'No open issues in this repository.'}
              </Text>
            )
          ) : (
            <Text className="text-sm text-neutral-500">
              No GitHub repository is linked to this project yet.
            </Text>
          )}
        </Surface>
      </section>

      <aside className="grid min-w-0 content-start gap-3">
        <Surface
          variant="tertiary"
          className="min-w-0 rounded-lg border border-neutral-800 bg-neutral-950/45 p-4"
        >
          <div className="mb-3 flex items-center gap-2">
            <ShieldCheck className="size-4 text-neutral-400" />
            <Text className="text-sm font-semibold text-neutral-100">Project health</Text>
          </div>
          <div className="grid gap-2">
            <StatLine label="Open issues" value={String(details.issues.length)} />
            <StatLine label="Branches" value={String(details.branches.length)} />
            <StatLine label="Template" value={project.fullstackTemplate?.status ?? 'unknown'} />
            <StatLine label="Machine" value={localMachine?.name ?? 'Local connector'} />
          </div>
        </Surface>

        <Surface
          variant="tertiary"
          className="min-w-0 rounded-lg border border-neutral-800 bg-neutral-950/45 p-4"
        >
          <div className="mb-3 flex items-center gap-2">
            <Play className="size-4 text-neutral-400" />
            <Text className="text-sm font-semibold text-neutral-100">Development session</Text>
          </div>
          <Text className="mb-3 block text-sm text-neutral-500">
            No active session for this project.
          </Text>
          <div className="grid gap-2">
            <Button variant="secondary" isDisabled={!project}>
              <GitBranchPlus className="size-4" />
              Start branch
            </Button>
            <Button variant="ghost" isDisabled={!selectedTargetPath}>
              <Play className="size-4" />
              Run tests
            </Button>
            <Button variant="ghost" isDisabled={!repository}>
              <Rocket className="size-4" />
              Create PR
            </Button>
          </div>
        </Surface>

        <Surface
          variant="tertiary"
          className="min-w-0 rounded-lg border border-neutral-800 bg-neutral-950/45 p-4"
        >
          <div className="mb-3 flex items-center gap-2">
            <Server className="size-4 text-neutral-400" />
            <Text className="text-sm font-semibold text-neutral-100">Active target</Text>
          </div>
          <Text className="block truncate font-mono text-xs text-neutral-500">
            {selectedTargetPath || 'No local checkout'}
          </Text>
        </Surface>

        <Surface
          variant="tertiary"
          className="min-w-0 rounded-lg border border-neutral-800 bg-neutral-950/45 p-4"
        >
          <div className="mb-3 flex items-center gap-2">
            <GitBranch className="size-4 text-neutral-400" />
            <Text className="text-sm font-semibold text-neutral-100">Branches</Text>
          </div>
          <div className="flex max-h-36 flex-col overflow-auto">
            {details.branches.slice(0, 5).map((branch) => (
              <a
                key={branch.name}
                href={branch.url ?? repository?.url}
                target="_blank"
                rel="noreferrer"
                className="flex min-w-0 items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-sm transition hover:bg-neutral-900/60"
              >
                <Text className="truncate text-neutral-200">{branch.name}</Text>
                {branch.isDefault ? (
                  <Chip size="sm" className="text-neutral-100">
                    base
                  </Chip>
                ) : null}
              </a>
            ))}
            {details.branches.length === 0 ? (
              <Text className="text-sm text-neutral-500">
                {message || 'No branches loaded yet.'}
              </Text>
            ) : null}
          </div>
        </Surface>
      </aside>
    </div>
  );
}
