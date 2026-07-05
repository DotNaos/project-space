import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  Columns3,
  ExternalLink,
  GitBranchPlus,
  List,
  ListChecks,
  Play,
  Rocket
} from 'lucide-react';
import { projectSpaceClient } from '@/api/project-space-client';
import { Button, Chip, Surface, Text, ToggleButton, ToggleButtonGroup } from '@/app/dotnaos-ui';
import type {
  GitHubCatalogRepository,
  GitHubIssueRecord,
  GitHubRepositoryDetailsResult
} from '@/shared/project-space-api';
import { GitHubMark } from './github-mark';
import { IssueMarkdown } from './issue-markdown';
import { repositoryDetailsFallback } from './project-main-model';

export function ProjectIssueDetailPanel({
  issueNumber,
  onBack,
  onOpenIssue,
  repository
}: {
  issueNumber?: number;
  onBack(): void;
  onOpenIssue(issueNumber: number): void;
  repository?: GitHubCatalogRepository;
}) {
  const [details, setDetails] = useState<GitHubRepositoryDetailsResult>();
  const [error, setError] = useState('');
  const [viewMode, setViewMode] = useState<'list' | 'kanban'>('list');

  useEffect(() => {
    if (!repository) {
      setDetails(undefined);
      return;
    }

    let canceled = false;
    setError('');

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
      });

    return () => {
      canceled = true;
    };
  }, [repository]);

  const safeDetails = details ?? repositoryDetailsFallback(repository ? 'connected' : 'error');
  const issue = safeDetails.issues.find((entry) => entry.number === issueNumber);
  const message =
    error ||
    safeDetails.message ||
    (!repository ? 'No GitHub repository is linked to this project.' : 'Loading issues...');

  return (
    <Surface
      variant="transparent"
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
    >
      <div className="mb-4 flex min-w-0 shrink-0 items-center justify-between gap-3">
        {issueNumber ? (
          <Button size="sm" variant="ghost" onPress={onBack}>
            <ArrowLeft className="size-4" />
            Issues
          </Button>
        ) : (
          <div className="flex items-center gap-2">
            <ListChecks className="size-4 text-neutral-400" />
            <Text className="text-sm font-semibold text-neutral-100">Issues</Text>
          </div>
        )}
        {issue?.url ? (
          <a
            href={issue.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs font-medium text-neutral-500 transition hover:bg-neutral-900 hover:text-neutral-200"
          >
            Open on GitHub
            <ExternalLink className="size-3.5" />
          </a>
        ) : !issueNumber ? (
          <ToggleButtonGroup
            aria-label="Issue view"
            selectedKeys={new Set([viewMode])}
            onSelectionChange={(keys) => {
              const nextMode = Array.from(keys)[0];

              if (nextMode === 'list' || nextMode === 'kanban') {
                setViewMode(nextMode);
              }
            }}
            className="rounded-lg bg-neutral-900/70 p-1"
          >
            <ToggleButton id="list" className="h-7 gap-1.5 rounded-md px-2 text-xs">
              <List className="size-3.5" />
              List
            </ToggleButton>
            <ToggleButton id="kanban" className="h-7 gap-1.5 rounded-md px-2 text-xs">
              <Columns3 className="size-3.5" />
              Kanban
            </ToggleButton>
          </ToggleButtonGroup>
        ) : null}
      </div>

      {issue ? (
        <IssueDetailWorkbench
          issue={issue}
          issues={safeDetails.issues}
          onOpenIssue={onOpenIssue}
        />
      ) : !issueNumber ? (
        <IssueWorkbench
          issues={safeDetails.issues}
          message={message}
          onOpenIssue={onOpenIssue}
          viewMode={viewMode}
        />
      ) : (
        <Text className="text-sm text-neutral-500">
          {details ? 'Issue was not found in the loaded open issues.' : message}
        </Text>
      )}
    </Surface>
  );
}

type KanbanColumnId = 'ready' | 'in-progress' | 'blocked' | 'backlog';

const kanbanColumns: Array<{
  id: KanbanColumnId;
  label: string;
}> = [
  { id: 'ready', label: 'Ready' },
  { id: 'in-progress', label: 'In progress' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'backlog', label: 'Backlog' }
];

function issueStatus(issue: GitHubIssueRecord, index: number): KanbanColumnId {
  const text = `${issue.title} ${issue.labels.join(' ')}`.toLowerCase();

  if (text.includes('blocked') || text.includes('blocker') || text.includes('waiting')) {
    return 'blocked';
  }

  if (text.includes('in progress') || text.includes('wip') || text.includes('doing')) {
    return 'in-progress';
  }

  if (text.includes('ready') || index < 4) {
    return 'ready';
  }

  return 'backlog';
}

function groupIssues(issues: GitHubIssueRecord[]) {
  const groups: Record<KanbanColumnId, GitHubIssueRecord[]> = {
    backlog: [],
    blocked: [],
    'in-progress': [],
    ready: []
  };

  issues.forEach((issue, index) => {
    groups[issueStatus(issue, index)].push(issue);
  });

  return groups;
}

function IssueWorkbench({
  issues,
  message,
  onOpenIssue,
  viewMode
}: {
  issues: GitHubIssueRecord[];
  message: string;
  onOpenIssue(issueNumber: number): void;
  viewMode: 'list' | 'kanban';
}) {
  if (issues.length === 0) {
    return <Text className="text-sm text-neutral-500">{message || 'No open issues.'}</Text>;
  }

  return viewMode === 'kanban' ? (
    <IssueKanbanBoard issues={issues} onOpenIssue={onOpenIssue} />
  ) : (
    <IssueList issues={issues} onOpenIssue={onOpenIssue} />
  );
}

function IssueList({
  issues,
  onOpenIssue
}: {
  issues: GitHubIssueRecord[];
  onOpenIssue(issueNumber: number): void;
}) {
  return (
    <div className="min-w-0">
      <div className="mb-2 flex items-center justify-between gap-3">
        <Text className="text-sm font-semibold text-neutral-100">Priority queue</Text>
        <Chip size="sm" variant="secondary">
          {issues.length} open
        </Chip>
      </div>
      <div className="flex max-h-[calc(100vh-20rem)] min-h-0 flex-col overflow-auto">
        {issues.map((issue) => (
          <IssueRow key={issue.number} issue={issue} onOpenIssue={onOpenIssue} />
        ))}
      </div>
    </div>
  );
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
        className="flex min-w-0 flex-1 items-start gap-3 px-2 py-3 text-left"
      >
        <Text className="shrink-0 text-xs text-neutral-500">#{issue.number}</Text>
        <span className="min-w-0 flex-1">
          <Text className="block truncate text-sm font-medium text-neutral-100">{issue.title}</Text>
          <Text className="mt-1 block truncate text-xs text-neutral-500">
            {issue.author ? `Opened by ${issue.author}` : 'Open issue'}
            {issue.updatedAt ? ` · updated ${new Date(issue.updatedAt).toLocaleDateString()}` : ''}
          </Text>
        </span>
      </button>
      {issue.labels.length > 0 ? (
        <span className="hidden max-w-44 shrink-0 flex-wrap justify-end gap-1 py-3 sm:flex">
          {issue.labels.slice(0, 2).map((label) => (
            <Chip key={label} size="sm" className="rounded-full bg-neutral-900 text-neutral-300">
              {label}
            </Chip>
          ))}
        </span>
      ) : null}
      {issue.url ? (
        <a
          href={issue.url}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open issue #${issue.number} on GitHub`}
          title="Open on GitHub"
          className="mr-1 mt-2 flex size-7 shrink-0 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-800 hover:text-neutral-100"
        >
          <GitHubMark className="size-3.5" />
        </a>
      ) : null}
    </div>
  );
}

function IssueKanbanBoard({
  issues,
  onOpenIssue
}: {
  issues: GitHubIssueRecord[];
  onOpenIssue(issueNumber: number): void;
}) {
  const groups = groupIssues(issues);

  return (
    <div className="min-w-0">
      <div className="mb-2 flex items-center justify-between gap-3">
        <Text className="text-sm font-semibold text-neutral-100">Kanban board</Text>
        <Text className="text-xs text-neutral-500">derived from labels and recency</Text>
      </div>
      <div className="grid min-h-[24rem] gap-2 lg:grid-cols-2 xl:grid-cols-4">
        {kanbanColumns.map((column) => (
          <section
            key={column.id}
            className="min-w-0 rounded-lg border border-neutral-800 bg-neutral-950/45 p-3"
          >
            <div className="mb-2 flex items-center justify-between gap-3">
              <Text className="text-xs font-semibold uppercase tracking-[0.14em] text-neutral-500">
                {column.label}
              </Text>
              <Text className="text-xs text-neutral-600">{groups[column.id].length}</Text>
            </div>
            <div className="grid gap-1.5">
              {groups[column.id].slice(0, 4).map((issue) => (
                <button
                  key={issue.number}
                  type="button"
                  onClick={() => onOpenIssue(issue.number)}
                  className="min-w-0 rounded-md border border-neutral-800/70 bg-black/20 px-2 py-2 text-left transition hover:border-neutral-700 hover:bg-neutral-900"
                >
                  <Text className="block text-xs text-neutral-500">#{issue.number}</Text>
                  <Text className="mt-1 block truncate text-sm font-medium text-neutral-100">
                    {issue.title}
                  </Text>
                </button>
              ))}
              {groups[column.id].length === 0 ? (
                <Text className="px-1 py-2 text-sm text-neutral-600">No issues.</Text>
              ) : null}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function IssueDetailWorkbench({
  issue,
  issues,
  onOpenIssue
}: {
  issue: GitHubIssueRecord;
  issues: GitHubIssueRecord[];
  onOpenIssue(issueNumber: number): void;
}) {
  return (
    <div className="grid min-h-0 flex-1 gap-4 overflow-hidden lg:grid-cols-[minmax(12rem,0.58fr)_minmax(0,1.15fr)_minmax(15rem,0.72fr)]">
      <IssueDetailList
        issues={issues}
        onOpenIssue={onOpenIssue}
        selectedIssueNumber={issue.number}
      />
      <IssueBody issue={issue} />
      <IssueActionPanel issue={issue} />
    </div>
  );
}

function IssueDetailList({
  issues,
  onOpenIssue,
  selectedIssueNumber
}: {
  issues: GitHubIssueRecord[];
  onOpenIssue(issueNumber: number): void;
  selectedIssueNumber: number;
}) {
  return (
    <aside className="flex min-h-0 min-w-0 flex-col">
      <div className="mb-2 flex items-center justify-between gap-3">
        <Text className="text-sm font-semibold text-neutral-100">Issues</Text>
        <Chip size="sm" variant="secondary">
          {issues.length}
        </Chip>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        {issues.map((entry) => {
          const isSelected = entry.number === selectedIssueNumber;

          return (
            <button
              key={entry.number}
              type="button"
              onClick={() => onOpenIssue(entry.number)}
              aria-current={isSelected ? 'true' : undefined}
              className={[
                'min-w-0 rounded-lg px-2 py-2 text-left transition',
                isSelected ? 'bg-neutral-800 text-neutral-50' : 'hover:bg-neutral-900/60'
              ].join(' ')}
            >
              <Text className="block text-xs text-neutral-500">#{entry.number}</Text>
              <Text className="mt-1 block truncate text-sm font-medium text-neutral-100">
                {entry.title}
              </Text>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

function IssueActionPanel({ issue }: { issue: GitHubIssueRecord }) {
  return (
    <aside className="grid min-w-0 content-start gap-3">
      <section className="rounded-lg border border-neutral-800 bg-black/20 p-3">
        <div className="mb-3 flex items-center gap-2">
          <Play className="size-4 text-neutral-400" />
          <Text className="text-sm font-semibold text-neutral-100">Development session</Text>
        </div>
        <Text className="mb-3 block text-sm text-neutral-500">
          Start work from issue #{issue.number}.
        </Text>
        <div className="grid gap-2">
          <Button variant="secondary">
            <GitBranchPlus className="size-4" />
            Start branch
          </Button>
          <Button variant="ghost">
            <Play className="size-4" />
            Run tests
          </Button>
          <Button variant="ghost">
            <Rocket className="size-4" />
            Create PR
          </Button>
        </div>
      </section>

      <section className="rounded-lg border border-neutral-800 bg-black/20 p-3">
        <Text className="mb-2 block text-sm font-semibold text-neutral-100">Issue status</Text>
        <div className="grid gap-2 text-sm">
          <div className="flex justify-between gap-3">
            <Text className="text-neutral-500">State</Text>
            <Text className="text-neutral-200">{issue.state}</Text>
          </div>
          <div className="flex justify-between gap-3">
            <Text className="text-neutral-500">Author</Text>
            <Text className="truncate text-neutral-200">{issue.author ?? 'unknown'}</Text>
          </div>
          <div className="flex justify-between gap-3">
            <Text className="text-neutral-500">Updated</Text>
            <Text className="truncate text-neutral-200">
              {issue.updatedAt ? new Date(issue.updatedAt).toLocaleDateString() : 'unknown'}
            </Text>
          </div>
        </div>
      </section>
    </aside>
  );
}

function IssueBody({ issue }: { issue: GitHubIssueRecord }) {
  return (
    <article className="min-h-0 min-w-0 overflow-auto pr-3">
      <div className="flex min-w-0 items-center gap-2">
        <ListChecks className="size-4 shrink-0 text-neutral-400" />
        <Text className="shrink-0 text-xs text-neutral-500">#{issue.number}</Text>
        <Chip size="sm" className="rounded-full px-2 py-0.5 text-emerald-300">
          {issue.state}
        </Chip>
      </div>

      <Text className="mt-3 block text-xl font-semibold leading-7 text-neutral-50">
        {issue.title}
      </Text>
      <Text className="mt-2 block text-sm text-neutral-500">
        {issue.author ? `Opened by ${issue.author}` : 'Open issue'}
        {issue.updatedAt ? ` · updated ${new Date(issue.updatedAt).toLocaleDateString()}` : ''}
      </Text>

      {issue.labels.length > 0 ? (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {issue.labels.map((label) => (
            <Chip
              key={label}
              size="sm"
              className="rounded-full bg-neutral-900 px-2 py-0.5 text-neutral-300"
            >
              {label}
            </Chip>
          ))}
        </div>
      ) : null}

      <IssueMarkdown markdown={issue.body} />
    </article>
  );
}
