import { Check } from 'lucide-react';
import { ListBox, ListBoxItem, Select } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import type { GitHistoryCommit } from '@/shared/project-space-api';
import type { GitBranchOption } from './git-graph-browser';

const selectorTriggerClass =
  'h-8 min-w-0 rounded-lg border border-neutral-800 bg-neutral-950/80 px-2.5 text-xs text-neutral-200 outline-none transition hover:border-neutral-700 hover:bg-neutral-900/70 focus-visible:border-neutral-500 focus-visible:ring-2 focus-visible:ring-neutral-800';

function SelectorItem({
  id,
  isSelected,
  primary,
  secondary
}: {
  id: string;
  isSelected: boolean;
  primary: string;
  secondary?: string;
}) {
  return (
    <ListBoxItem
      id={id}
      textValue={primary}
      className={cn(
        'flex w-full min-w-0 items-center gap-2 rounded-md px-2.5 py-2 text-left transition',
        isSelected ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-400 hover:bg-neutral-900/80'
      )}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-xs font-medium">{primary}</span>
        {secondary ? (
          <span className="mt-0.5 truncate font-mono text-[10px] text-neutral-600">{secondary}</span>
        ) : null}
      </span>
      {isSelected ? <Check className="size-3.5 shrink-0 text-neutral-200" /> : null}
    </ListBoxItem>
  );
}

export function DiffSourceSelect({
  branchRef,
  branches,
  onChange
}: {
  branchRef: string;
  branches: GitBranchOption[];
  onChange(value: string): void;
}) {
  const selectedLabel =
    branchRef === ''
      ? 'Working tree'
      : branches.find((branch) => branch.ref === branchRef)?.label ?? branchRef;

  return (
    <Select
      aria-label="Diff source"
      value={branchRef}
      onChange={(value) => onChange(value ?? '')}
      className="w-44 shrink-0"
    >
      <Select.Trigger className={selectorTriggerClass}>
        <span className="min-w-0 flex-1 truncate text-left">{selectedLabel}</span>
        <Select.Indicator className="size-3.5 shrink-0 text-neutral-500" />
      </Select.Trigger>
      <Select.Popover className="w-64 rounded-lg border border-neutral-800/80 bg-neutral-950 shadow-2xl shadow-black/50">
        <ListBox selectedKeys={new Set([branchRef])} className="max-h-72 overflow-auto p-1">
          <SelectorItem
            id=""
            isSelected={branchRef === ''}
            primary="Working tree"
            secondary="Local changes"
          />
          {branches.map((branch) => (
            <SelectorItem
              key={branch.ref}
              id={branch.ref}
              isSelected={branchRef === branch.ref}
              primary={branch.label}
              secondary={branch.tip ? branch.tip.hash.slice(0, 8) : 'remote only'}
            />
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

export function CommitSelect({
  commitHash,
  commits,
  onChange
}: {
  commitHash: string;
  commits: GitHistoryCommit[];
  onChange(value: string): void;
}) {
  const selectedCommit = commits.find((commit) => commit.hash === commitHash);
  const selectedLabel = selectedCommit
    ? `${selectedCommit.hash.slice(0, 8)} · ${selectedCommit.subject}`
    : 'Select commit';

  return (
    <Select
      aria-label="Commit"
      value={commitHash}
      onChange={(value) => onChange(value ?? '')}
      className="min-w-0 max-w-96 flex-1"
    >
      <Select.Trigger className={selectorTriggerClass}>
        <span className="min-w-0 flex-1 truncate text-left">{selectedLabel}</span>
        <Select.Indicator className="size-3.5 shrink-0 text-neutral-500" />
      </Select.Trigger>
      <Select.Popover className="w-[min(32rem,calc(100vw-2rem))] rounded-lg border border-neutral-800/80 bg-neutral-950 shadow-2xl shadow-black/50">
        <ListBox selectedKeys={new Set([commitHash])} className="max-h-80 overflow-auto p-1">
          {commits.map((commit) => (
            <SelectorItem
              key={commit.hash}
              id={commit.hash}
              isSelected={commitHash === commit.hash}
              primary={commit.subject}
              secondary={`${commit.hash.slice(0, 8)} · ${commit.date}`}
            />
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}
