import { useEffect, useState } from 'react';
import { Check, ChevronDown, GitBranch, GitPullRequest, ListFilter, PanelLeftClose, Trash2 } from 'lucide-react';
import { projectSpaceClient } from '@/api/project-space-client';
import { Button, Chip, Text } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import type {
  GitHistoryCommit,
  GitHubBranchRecord,
  GitHubPullRequestRecord
} from '@/shared/project-space-api';
import { DiffView } from './diff-view';

export interface GitBranchOption {
  color?: string;
  githubUrl?: string;
  isCurrent: boolean;
  isDefault: boolean;
  label: string;
  prs: GitHubPullRequestRecord[];
  ref: string;
  sources: Array<'local' | 'remote' | 'github'>;
  tip?: GitHistoryCommit;
}

function addBranch(
  branches: Map<string, GitBranchOption>,
  input: {
    isCurrent?: boolean;
    label: string;
    ref: string;
    source: 'local' | 'remote';
    tip: GitHistoryCommit;
  }
) {
  const existing = branches.get(input.label);

  if (!existing) {
    branches.set(input.label, {
      isCurrent: Boolean(input.isCurrent),
      isDefault: false,
      label: input.label,
      prs: [],
      ref: input.ref,
      sources: [input.source],
      tip: input.tip
    });
    return;
  }

  if (!existing.sources.includes(input.source)) {
    existing.sources.push(input.source);
  }

  if (input.isCurrent || existing.ref.startsWith('origin/')) {
    existing.ref = input.ref;
  }

  existing.isCurrent = existing.isCurrent || Boolean(input.isCurrent);
  existing.tip = existing.tip ?? input.tip;
}

export function buildGitBranchOptions(
  commits: GitHistoryCommit[],
  githubBranches: GitHubBranchRecord[] = [],
  pullRequests: GitHubPullRequestRecord[] = []
) {
  const branches = new Map<string, GitBranchOption>();

  for (const commit of commits) {
    for (const ref of commit.refs) {
      const isCurrent = ref.startsWith('HEAD ->');
      const cleanRef = ref.replace(/^HEAD -> /, '').trim();

      if (
        !cleanRef ||
        cleanRef === 'HEAD' ||
        cleanRef === 'origin/HEAD' ||
        cleanRef.startsWith('tag: ')
      ) {
        continue;
      }

      const isRemote = cleanRef.startsWith('origin/');
      const label = isRemote ? cleanRef.slice('origin/'.length) : cleanRef;

      addBranch(branches, {
        isCurrent,
        label,
        ref: cleanRef,
        source: isRemote ? 'remote' : 'local',
        tip: commit
      });
    }
  }

  for (const branch of githubBranches) {
    const existing = branches.get(branch.name);

    if (existing) {
      existing.githubUrl = branch.url;
      existing.isDefault = branch.isDefault;
      if (!existing.sources.includes('github')) {
        existing.sources.push('github');
      }
    } else {
      branches.set(branch.name, {
        githubUrl: branch.url,
        isCurrent: false,
        isDefault: branch.isDefault,
        label: branch.name,
        prs: [],
        ref: branch.name,
        sources: ['github']
      });
    }
  }

  const githubBranchNames = new Set(githubBranches.map((branch) => branch.name));
  const hasGithubBranchSource = githubBranches.length > 0;

  for (const pullRequest of pullRequests) {
    if (!pullRequest.headBranch) {
      continue;
    }

    const branch = branches.get(pullRequest.headBranch);
    if (branch) {
      branch.prs.push(pullRequest);
    }
  }

  return Array.from(branches.values()).filter((branch) => {
    if (!hasGithubBranchSource) {
      return true;
    }

    if (branch.sources.includes('local') || branch.sources.includes('github')) {
      return true;
    }

    return githubBranchNames.has(branch.label);
  }).sort((left, right) => {
    if (left.isCurrent !== right.isCurrent) {
      return left.isCurrent ? -1 : 1;
    }

    if (left.isDefault !== right.isDefault) {
      return left.isDefault ? -1 : 1;
    }

    if (left.label === 'main') {
      return -1;
    }

    if (right.label === 'main') {
      return 1;
    }

    return left.label.localeCompare(right.label);
  });
}

export function GitBranchSidebar({
  activeBranchLabel,
  branches,
  isFilterActive,
  isLoading,
  onCollapse,
  onDeleteBranch,
  onHoverBranch,
  onSelectBranch,
  onToggleBranch,
  onToggleFilter,
  visibleBranchLabels
}: {
  activeBranchLabel?: string;
  branches: GitBranchOption[];
  isFilterActive: boolean;
  isLoading: boolean;
  onCollapse?(): void;
  onDeleteBranch?(branch: GitBranchOption): void;
  onHoverBranch?(branch: GitBranchOption | null): void;
  onSelectBranch?(branch: GitBranchOption): void;
  onToggleBranch?(branch: GitBranchOption): void;
  onToggleFilter?(): void;
  visibleBranchLabels: Set<string>;
}) {
  const visibleCount = branches.filter((branch) => visibleBranchLabels.has(branch.label)).length;

  return (
    <aside className="flex h-full min-h-0 flex-col overflow-hidden border-r border-neutral-800/70">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-neutral-800/70 py-1.5 pl-3 pr-1">
        <GitBranch className="size-4 shrink-0 text-neutral-500" />
        <Text className="shrink-0 whitespace-nowrap text-[10px] font-semibold uppercase tracking-[0.1em] text-neutral-500">
          Branches
        </Text>
        <Text className="ml-auto shrink-0 whitespace-nowrap text-[11px] text-neutral-600">
          {branches.length > 0 ? (isFilterActive ? `${visibleCount}/${branches.length}` : branches.length) : ''}
        </Text>
        <Button
          aria-label={isFilterActive ? 'Hide branch filters' : 'Filter branches'}
          isIconOnly
          size="sm"
          variant="ghost"
          className={cn(
            'shrink-0',
            isFilterActive && 'bg-neutral-800 text-neutral-100 hover:bg-neutral-800'
          )}
          onPress={onToggleFilter}
        >
          <ListFilter className="size-3.5" />
        </Button>
        {onCollapse ? (
          <Button
            aria-label="Collapse branches"
            isIconOnly
            size="sm"
            variant="ghost"
            className="shrink-0"
            onPress={onCollapse}
          >
            <PanelLeftClose className="size-3.5" />
          </Button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {branches.map((branch) => (
          <BranchButton
            key={branch.label}
            branch={branch}
            isActive={activeBranchLabel === branch.label}
            isFilterActive={isFilterActive}
            isVisible={visibleBranchLabels.has(branch.label)}
            label={branch.label}
            onDelete={onDeleteBranch ? () => onDeleteBranch(branch) : undefined}
            onHover={(nextBranch) => onHoverBranch?.(nextBranch)}
            onPress={() => onSelectBranch?.(branch)}
            onToggleVisible={() => onToggleBranch?.(branch)}
          />
        ))}
        {branches.length === 0 ? (
          <Text className="block px-2 py-4 text-xs text-neutral-600">
            {isLoading ? 'Loading branches...' : 'No branches found.'}
          </Text>
        ) : null}
      </div>
    </aside>
  );
}

function BranchButton({
  branch,
  isActive,
  isFilterActive,
  isVisible,
  label,
  onHover,
  onDelete,
  onPress,
  onToggleVisible
}: {
  branch?: GitBranchOption;
  isActive: boolean;
  isFilterActive: boolean;
  isVisible: boolean;
  label: string;
  onHover?(branch: GitBranchOption | null): void;
  onDelete?(): void;
  onPress(): void;
  onToggleVisible?(): void;
}) {
  const openPr = branch?.prs.find((pr) => pr.state === 'open');
  const mergedPr = branch?.prs.find((pr) => pr.state === 'merged');
  const shownPr = openPr ?? mergedPr ?? branch?.prs[0];

  return (
    <div
      onBlur={() => onHover?.(null)}
      onFocus={() => onHover?.(branch ?? null)}
      onMouseEnter={() => onHover?.(branch ?? null)}
      onMouseLeave={() => onHover?.(null)}
      onMouseMove={() => onHover?.(branch ?? null)}
      onPointerEnter={() => onHover?.(branch ?? null)}
      onPointerMove={() => onHover?.(branch ?? null)}
      className={cn(
        'mb-1 flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-left outline-none transition focus-visible:ring-2 focus-visible:ring-neutral-500/70',
        isActive ? 'bg-neutral-800/80 text-neutral-100' : 'text-neutral-400 hover:bg-neutral-900/70',
        isFilterActive && !isVisible && 'opacity-45'
      )}
    >
      {isFilterActive ? (
        <button
          aria-checked={isVisible}
          aria-label={`${isVisible ? 'Hide' : 'Show'} ${label}`}
          className={cn(
            'flex size-4 shrink-0 items-center justify-center rounded border transition',
            isVisible
              ? 'border-sky-400 bg-sky-400/15 text-sky-200'
              : 'border-neutral-700 bg-neutral-950 text-transparent hover:border-neutral-500'
          )}
          role="checkbox"
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onToggleVisible?.();
          }}
        >
          <Check className="size-3" />
        </button>
      ) : null}
      <GitBranch
        className={cn('size-3.5 shrink-0', !branch?.color && (branch?.isCurrent ? 'text-emerald-400' : 'text-neutral-600'))}
        style={branch?.color ? { color: branch.color } : undefined}
      />
      <button
        className="min-w-0 flex-1 text-left outline-none"
        type="button"
        onClick={() => {
          onHover?.(branch ?? null);
          onPress();
        }}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-sm font-medium">{label}</span>
          {branch?.isCurrent ? (
            <span className="size-1.5 shrink-0 rounded-full bg-emerald-400" title="Current branch" />
          ) : null}
        </span>
        {branch ? (
          <span className="mt-0.5 flex items-center gap-1.5 font-mono text-[10px] text-neutral-600">
            {branch.tip ? <span>{branch.tip.hash.slice(0, 8)}</span> : <span>remote only</span>}
            {branch.isDefault ? (
              <span className="rounded-full border border-neutral-800 px-1 font-sans text-[9px] uppercase tracking-[0.1em]">
                default
              </span>
            ) : null}
            {shownPr ? (
              <span
                className={cn(
                  'inline-flex items-center gap-0.5 font-sans text-[10px]',
                  shownPr.state === 'merged' ? 'text-violet-300' : 'text-sky-300'
                )}
              >
                <GitPullRequest className="size-2.5" />
                {shownPr.state === 'merged' ? 'merged ' : ''}#{shownPr.number}
              </span>
            ) : null}
          </span>
        ) : null}
      </button>
      {mergedPr && !branch?.isDefault && onDelete ? (
        <button
          aria-label={`Delete merged branch ${label}`}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-neutral-500 transition hover:bg-red-400/10 hover:text-red-200"
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onDelete();
          }}
        >
          <Trash2 className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

export function GitCommitDetailsPane({
  commit,
  isCollapsed = false,
  onToggleCollapse,
  targetPath
}: {
  commit?: GitHistoryCommit;
  isCollapsed?: boolean;
  onToggleCollapse?(): void;
  targetPath: string;
}) {
  const [diff, setDiff] = useState('');
  const [isDiffLoading, setIsDiffLoading] = useState(false);

  useEffect(() => {
    if (!commit || !targetPath || isCollapsed) {
      setDiff('');
      return;
    }

    let canceled = false;

    setIsDiffLoading(true);
    projectSpaceClient
      .getGitDiff({ commit: commit.hash, cwd: targetPath })
      .then((result) => {
        if (!canceled) {
          setDiff(result.diff);
        }
      })
      .catch((error) => {
        if (!canceled) {
          setDiff(error instanceof Error ? error.message : 'Could not load the commit diff.');
        }
      })
      .finally(() => {
        if (!canceled) {
          setIsDiffLoading(false);
        }
      });

    return () => {
      canceled = true;
    };
  }, [commit?.hash, isCollapsed, targetPath]);

  if (!commit) {
    return (
      <Text className="block px-4 py-6 text-sm text-neutral-500">
        Select a commit to see its changes.
      </Text>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className={cn(
          'shrink-0 px-4 py-3',
          !isCollapsed && 'border-b border-neutral-800/70'
        )}
      >
        <div className="flex min-w-0 items-start justify-between gap-3">
          <Text className="min-w-0 text-sm font-semibold leading-5 text-neutral-100">
            {commit.subject}
          </Text>
          <span className="flex shrink-0 items-center gap-1.5">
            <Text className="font-mono text-[11px] text-neutral-500">
              {commit.hash.slice(0, 10)}
            </Text>
            {onToggleCollapse ? (
              <Button
                aria-expanded={!isCollapsed}
                aria-label={isCollapsed ? 'Expand commit details' : 'Collapse commit details'}
                isIconOnly
                size="sm"
                variant="ghost"
                className="-my-1"
                onPress={onToggleCollapse}
              >
                <ChevronDown
                  className={cn('size-4 transition-transform', isCollapsed && 'rotate-180')}
                />
              </Button>
            ) : null}
          </span>
        </div>
        {isCollapsed ? null : (
          <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-500">
            <span className="truncate">{commit.author}</span>
            <span className="shrink-0">{commit.date}</span>
            {commit.parents.length > 1 ? <span className="shrink-0">merge commit</span> : null}
            {commit.refs.map((ref) => (
              <Chip key={ref} size="sm" variant="secondary" className="max-w-48">
                <span className="truncate">{ref.replace(/^HEAD -> /, '')}</span>
              </Chip>
            ))}
          </div>
        )}
      </div>
      {isCollapsed ? null : (
        <div className="min-h-0 flex-1 overflow-auto">
          {isDiffLoading ? (
            <Text className="block px-4 py-6 text-sm text-neutral-500">Loading diff...</Text>
          ) : (
            <DiffView diff={diff} emptyMessage="This commit has no textual changes." />
          )}
        </div>
      )}
    </div>
  );
}
