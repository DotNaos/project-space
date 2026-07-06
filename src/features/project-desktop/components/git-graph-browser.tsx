import { GitBranch, GitCommitHorizontal } from 'lucide-react';
import { Chip, Text } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import type { GitHistoryCommit } from '@/shared/project-space-api';

export interface GitBranchOption {
  isCurrent: boolean;
  label: string;
  ref: string;
  sources: Array<'local' | 'remote'>;
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
      label: input.label,
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

export function buildGitBranchOptions(commits: GitHistoryCommit[]) {
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

  return Array.from(branches.values()).sort((left, right) => {
    if (left.isCurrent !== right.isCurrent) {
      return left.isCurrent ? -1 : 1;
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
  onSelectRef,
  selectedRef
}: {
  branches: GitBranchOption[];
  isLoading: boolean;
  onSelectRef(ref: string): void;
  selectedRef: string;
}) {
  return (
    <aside className="min-h-0 overflow-hidden border-r border-neutral-800/70">
      <div className="flex items-center gap-2 border-b border-neutral-800/70 px-3 py-2.5">
        <GitBranch className="size-4 text-neutral-500" />
        <Text className="text-xs font-semibold uppercase tracking-[0.14em] text-neutral-500">
          Branches
        </Text>
      </div>
      <div className="min-h-0 overflow-auto p-2">
        <BranchButton
          isActive={selectedRef === 'all'}
          label="All branches"
          onPress={() => onSelectRef('all')}
          sources={[]}
        />
        {branches.map((branch) => (
          <BranchButton
            key={branch.label}
            isActive={selectedRef === branch.ref}
            label={branch.label}
            onPress={() => onSelectRef(branch.ref)}
            sources={branch.sources}
            subtitle={branch.tip?.hash.slice(0, 8)}
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
  isActive,
  label,
  onPress,
  sources,
  subtitle
}: {
  isActive: boolean;
  label: string;
  onPress(): void;
  sources: Array<'local' | 'remote'>;
  subtitle?: string;
}) {
  return (
    <button
      type="button"
      onClick={onPress}
      className={cn(
        'mb-1 flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-left transition',
        isActive ? 'bg-neutral-800/80 text-neutral-100' : 'text-neutral-400 hover:bg-neutral-900/70'
      )}
    >
      <GitBranch className="size-3.5 shrink-0 text-neutral-600" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{label}</span>
        {subtitle ? (
          <span className="block font-mono text-[10px] text-neutral-600">{subtitle}</span>
        ) : null}
      </span>
      {sources.length > 0 ? (
        <span className="flex shrink-0 gap-1">
          {sources.map((source) => (
            <span
              key={source}
              className="rounded-full border border-neutral-800 px-1 py-0.5 text-[9px] uppercase tracking-[0.12em] text-neutral-500"
            >
              {source[0]}
            </span>
          ))}
        </span>
      ) : null}
    </button>
  );
}

export function GitCommitDetails({ commit }: { commit?: GitHistoryCommit }) {
  return (
    <aside className="min-h-0 overflow-hidden border-l border-neutral-800/70">
      <div className="flex items-center gap-2 border-b border-neutral-800/70 px-4 py-2.5">
        <GitCommitHorizontal className="size-4 text-neutral-500" />
        <Text className="text-xs font-semibold uppercase tracking-[0.14em] text-neutral-500">
          Commit
        </Text>
      </div>
      {!commit ? (
        <Text className="block px-4 py-6 text-sm text-neutral-500">Select a commit.</Text>
      ) : (
        <div className="min-h-0 overflow-auto px-4 py-4">
          <Text className="block text-sm font-semibold leading-5 text-neutral-100">
            {commit.subject}
          </Text>
          <Text className="mt-3 block break-all font-mono text-[11px] leading-4 text-neutral-500">
            {commit.hash}
          </Text>
          <div className="mt-4 grid gap-3 text-xs">
            <DetailRow label="Author" value={commit.author} />
            <DetailRow label="Date" value={commit.date} />
            <DetailRow
              label="Parents"
              value={commit.parents.length > 0 ? commit.parents.map((hash) => hash.slice(0, 8)).join(', ') : 'none'}
            />
          </div>
          {commit.refs.length > 0 ? (
            <div className="mt-4 flex flex-wrap gap-1">
              {commit.refs.map((ref) => (
                <Chip key={ref} size="sm" variant="secondary" className="max-w-full">
                  <span className="truncate">{ref.replace(/^HEAD -> /, '')}</span>
                </Chip>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </aside>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <Text className="block text-[10px] uppercase tracking-[0.14em] text-neutral-600">
        {label}
      </Text>
      <Text className="mt-1 block break-words text-neutral-300">{value}</Text>
    </div>
  );
}
