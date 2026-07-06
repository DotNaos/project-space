import { useMemo } from 'react';
import { ExternalLink, GitBranch, GitPullRequest, RefreshCw } from 'lucide-react';
import { Button, Chip, Surface, Text } from '@/app/dotnaos-ui';
import type {
  GitHistoryCommit,
  GitHubBranchRecord,
  GitHubIssueRecord,
  GitHubPullRequestRecord,
  GitStatusResult
} from '@/shared/project-space-api';

interface BranchRow {
  commit?: GitHistoryCommit;
  github?: GitHubBranchRecord;
  isCurrent: boolean;
  issues: GitHubIssueRecord[];
  name: string;
  prs: GitHubPullRequestRecord[];
  sources: Array<'local' | 'remote' | 'github'>;
}

function normalizeBranchName(ref: string) {
  return ref.replace(/^HEAD -> /, '').replace(/^origin\//, '').trim();
}

function branchRefKind(ref: string): 'local' | 'remote' | undefined {
  const normalized = ref.replace(/^HEAD -> /, '').trim();

  if (
    !normalized ||
    normalized === 'HEAD' ||
    normalized === 'origin/HEAD' ||
    normalized.startsWith('tag: ')
  ) {
    return undefined;
  }

  return normalized.startsWith('origin/') ? 'remote' : 'local';
}

function buildBranchRows({
  commits,
  currentBranch,
  githubBranches,
  issues,
  pullRequests
}: {
  commits: GitHistoryCommit[];
  currentBranch?: string;
  githubBranches: GitHubBranchRecord[];
  issues: GitHubIssueRecord[];
  pullRequests: GitHubPullRequestRecord[];
}) {
  const rows = new Map<string, BranchRow>();

  function ensure(name: string) {
    const existing = rows.get(name);
    if (existing) {
      return existing;
    }

    const next: BranchRow = {
      isCurrent: currentBranch === name,
      issues: [],
      name,
      prs: [],
      sources: []
    };
    rows.set(name, next);
    return next;
  }

  if (currentBranch && currentBranch !== 'detached') {
    ensure(currentBranch).sources.push('local');
  }

  for (const commit of commits) {
    for (const ref of commit.refs) {
      const kind = branchRefKind(ref);

      if (!kind) {
        continue;
      }

      const row = ensure(normalizeBranchName(ref));
      if (!row.commit) {
        row.commit = commit;
      }
      if (!row.sources.includes(kind)) {
        row.sources.push(kind);
      }
    }
  }

  for (const branch of githubBranches) {
    const row = ensure(branch.name);
    row.github = branch;
    if (!row.sources.includes('github')) {
      row.sources.push('github');
    }
    row.issues = issues.filter((issue) => branch.linkedIssueNumbers?.includes(issue.number));
    row.prs = pullRequests.filter((pullRequest) => pullRequest.headBranch === branch.name);
  }

  return Array.from(rows.values()).sort((left, right) => {
    if (left.isCurrent !== right.isCurrent) {
      return left.isCurrent ? -1 : 1;
    }

    if (left.github?.isDefault !== right.github?.isDefault) {
      return left.github?.isDefault ? -1 : 1;
    }

    return left.name.localeCompare(right.name);
  });
}

export function GitBranchesPanel({
  commits,
  githubBranches,
  isLoading,
  issues,
  message,
  pullRequests,
  refresh,
  repositoryFullName,
  status
}: {
  commits: GitHistoryCommit[];
  githubBranches: GitHubBranchRecord[];
  isLoading: boolean;
  issues: GitHubIssueRecord[];
  message: string;
  pullRequests: GitHubPullRequestRecord[];
  refresh(): Promise<void>;
  repositoryFullName?: string;
  status?: GitStatusResult;
}) {
  const rows = useMemo(
    () =>
      buildBranchRows({
        commits,
        currentBranch: status?.branchName,
        githubBranches,
        issues,
        pullRequests
      }),
    [commits, githubBranches, issues, pullRequests, status?.branchName]
  );

  return (
    <Surface
      variant="tertiary"
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950/45"
    >
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-neutral-800 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <GitBranch className="size-4 shrink-0 text-neutral-400" />
          <Text className="truncate text-sm font-semibold text-neutral-100">Branches</Text>
          <Text className="shrink-0 text-xs text-neutral-500">
            {rows.length > 0 ? `${rows.length} branches` : ''}
          </Text>
        </div>
        <Button
          aria-label="Refresh branches"
          size="sm"
          variant="ghost"
          isDisabled={isLoading}
          onPress={() => void refresh()}
        >
          <RefreshCw className={isLoading ? 'size-4 animate-spin' : 'size-4'} />
        </Button>
      </div>

      {message && rows.length === 0 ? (
        <Text className="block px-4 py-6 text-sm text-neutral-500">{message}</Text>
      ) : rows.length === 0 ? (
        <Text className="block px-4 py-6 text-sm text-neutral-500">
          {isLoading ? 'Loading branches...' : 'No branches found.'}
        </Text>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="grid min-w-[48rem] grid-cols-[minmax(14rem,1fr)_13rem_minmax(18rem,1.2fr)_8rem] border-b border-neutral-800/70 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-neutral-600">
            <span>Branch</span>
            <span>Linked work</span>
            <span>Last seen commit</span>
            <span className="text-right">Open</span>
          </div>
          {rows.map((row) => (
            <div
              key={row.name}
              className="grid min-w-[48rem] grid-cols-[minmax(14rem,1fr)_13rem_minmax(18rem,1.2fr)_8rem] items-center gap-3 border-b border-neutral-900 px-4 py-3 transition hover:bg-neutral-900/45"
            >
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <GitBranch className="size-4 shrink-0 text-neutral-500" />
                  <Text className="truncate text-sm font-semibold text-neutral-100">
                    {row.name}
                  </Text>
                  {row.isCurrent ? (
                    <Chip
                      size="sm"
                      variant="secondary"
                      className="border-emerald-400/25 text-emerald-300"
                    >
                      current
                    </Chip>
                  ) : null}
                  {row.github?.isDefault ? (
                    <Chip size="sm" variant="secondary">
                      default
                    </Chip>
                  ) : null}
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {row.sources.map((source) => (
                    <span
                      key={source}
                      className="rounded-full border border-neutral-800 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.1em] text-neutral-500"
                    >
                      {source}
                    </span>
                  ))}
                </div>
              </div>

              <div className="flex min-w-0 flex-wrap gap-1">
                {row.issues.map((issue) => (
                  <Chip key={issue.number} size="sm" variant="secondary">
                    #{issue.number}
                  </Chip>
                ))}
                {row.prs.map((pr) => (
                  <Chip
                    key={pr.number}
                    size="sm"
                    variant="secondary"
                    className="border-sky-400/25 text-sky-200"
                  >
                    <GitPullRequest className="size-3" />
                    #{pr.number}
                  </Chip>
                ))}
                {row.issues.length === 0 && row.prs.length === 0 ? (
                  <Text className="text-xs text-neutral-600">none</Text>
                ) : null}
              </div>

              <div className="min-w-0">
                <Text className="block truncate text-sm text-neutral-300">
                  {row.commit?.subject ?? 'Not present in loaded history'}
                </Text>
                {row.commit ? (
                  <Text className="font-mono text-[11px] text-neutral-600">
                    {row.commit.hash.slice(0, 8)} - {row.commit.date}
                  </Text>
                ) : null}
              </div>

              <div className="flex justify-end">
                {row.github?.url ? (
                  <a
                    href={row.github.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-neutral-500 transition hover:bg-neutral-900 hover:text-neutral-200"
                  >
                    GitHub
                    <ExternalLink className="size-3" />
                  </a>
                ) : repositoryFullName ? (
                  <Text className="text-xs text-neutral-700">
                    {row.sources.includes('remote') ? 'remote' : 'local'}
                  </Text>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </Surface>
  );
}
