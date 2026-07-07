import { useEffect, useState } from 'react';
import { ChevronDown, GitBranch, GitPullRequest, PanelLeftClose } from 'lucide-react';
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

  for (const pullRequest of pullRequests) {
    if (!pullRequest.headBranch) {
      continue;
    }

    const branch = branches.get(pullRequest.headBranch);
    if (branch) {
      branch.prs.push(pullRequest);
    }
  }

  return Array.from(branches.values()).sort((left, right) => {
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
  branches,
  isLoading,
  onCollapse,
  onSelectRef,
  selectedRef
}: {
  branches: GitBranchOption[];
  isLoading: boolean;
  onCollapse?(): void;
  onSelectRef(ref: string): void;
  selectedRef: string;
}) {
  return (
    <aside className="flex h-full min-h-0 flex-col overflow-hidden border-r border-neutral-800/70">
      <div className="flex shrink-0 items-center gap-2 border-b border-neutral-800/70 py-1.5 pl-3 pr-1.5">
        <GitBranch className="size-4 text-neutral-500" />
        <Text className="text-xs font-semibold uppercase tracking-[0.14em] text-neutral-500">
          Branches
        </Text>
        <Text className="ml-auto text-[11px] text-neutral-600">
          {branches.length > 0 ? branches.length : ''}
        </Text>
        {onCollapse ? (
          <Button
            aria-label="Collapse branches"
            isIconOnly
            size="sm"
            variant="ghost"
            onPress={onCollapse}
          >
            <PanelLeftClose className="size-3.5" />
          </Button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        <BranchButton
          isActive={selectedRef === 'all'}
          label="All branches"
          onPress={() => onSelectRef('all')}
        />
        {branches.map((branch) => (
          <BranchButton
            key={branch.label}
            branch={branch}
            isActive={selectedRef === branch.ref}
            label={branch.label}
            onPress={() => onSelectRef(branch.ref)}
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
  label,
  onPress
}: {
  branch?: GitBranchOption;
  isActive: boolean;
  label: string;
  onPress(): void;
}) {
  const openPr = branch?.prs.find((pr) => pr.state === 'open') ?? branch?.prs[0];

  return (
    <button
      type="button"
      onClick={onPress}
      className={cn(
        'mb-1 flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-left transition',
        isActive ? 'bg-neutral-800/80 text-neutral-100' : 'text-neutral-400 hover:bg-neutral-900/70'
      )}
    >
      <GitBranch
        className={cn(
          'size-3.5 shrink-0',
          branch?.isCurrent ? 'text-emerald-400' : 'text-neutral-600'
        )}
      />
      <span className="min-w-0 flex-1">
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
            {openPr ? (
              <span className="inline-flex items-center gap-0.5 font-sans text-[10px] text-sky-300">
                <GitPullRequest className="size-2.5" />#{openPr.number}
              </span>
            ) : null}
          </span>
        ) : null}
      </span>
    </button>
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
