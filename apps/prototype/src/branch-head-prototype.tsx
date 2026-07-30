import { GitBranch, GitPullRequest, History, Play } from 'lucide-react';

import { Chip, Surface, Text } from '../../../src/app/dotnaos-ui';
import { BranchHeadGraphPreview } from '../../../src/features/project-desktop/components/branch-head-graph-preview';
import type { GitHubBranchComparisonResult } from '../../../src/shared/project-space-api';
import type { PrototypeTheme } from '../../../src/shared/prototype-canvas';

const mergeBase = '1'.repeat(40);
const headSha = 'a'.repeat(40);
const headParent = 'b'.repeat(40);
const defaultSha = 'd'.repeat(40);
const defaultParent = 'e'.repeat(40);
const checkedAt = '2026-07-30T09:00:00.000Z';

const comparison: GitHubBranchComparisonResult = {
  aheadBy: 2,
  behindBy: 2,
  checkedAt,
  commits: [
    commit(headSha, [headParent], 'Show the verified branch head graph'),
    commit(defaultSha, [defaultParent], 'Keep default branch checks current'),
    commit(headParent, [mergeBase], 'Add bounded comparison states'),
    commit(defaultParent, [mergeBase], 'Harden preview deployment status'),
    commit(mergeBase, [], 'Share issue development context')
  ],
  defaultBranch: { name: 'main', sha: defaultSha },
  freshness: 'current',
  head: {
    name: 'issue-408-show-a-focused-git-graph-around-the-linked-branch-head',
    sha: headSha
  },
  mergeBaseIncluded: true,
  mergeBaseSha: mergeBase,
  state: 'diverged',
  status: 'connected',
  truncated: true
};

function commit(hash: string, parents: string[], subject: string) {
  return {
    author: 'DotNaos',
    date: checkedAt,
    hash,
    parents,
    refs: [],
    subject
  };
}

export function BranchHeadPrototype({ theme }: { theme: PrototypeTheme }) {
  return (
    <div
      className={`prototype-target min-h-full px-5 py-7 @md:px-8 @md:py-9 ${
        theme === 'light' ? 'prototype-target--light' : 'prototype-target--dark'
      }`}
    >
      <header className="mx-auto mb-7 flex w-full max-w-5xl items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="truncate text-base font-semibold text-neutral-100">project-space</p>
          <p className="mt-1 text-xs text-neutral-500">DotNaos / Issues / #408</p>
        </div>
        <Chip size="sm" variant="secondary" className="border border-emerald-400/20 bg-emerald-500/10 text-emerald-200">
          Open
        </Chip>
      </header>

      <main className="mx-auto grid w-full max-w-5xl gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(22rem,0.78fr)]">
        <section className="min-w-0 pt-1">
          <Text as="h1" className="block text-xl font-semibold leading-tight text-neutral-100">
            Show a focused Git graph around the linked branch head
          </Text>
          <Text className="mt-3 block max-w-2xl text-sm leading-6 text-neutral-400">
            See whether the verified pull request head is current, ahead, behind, or diverged
            from the repository default branch without leaving the issue.
          </Text>
          <div className="mt-7 flex flex-wrap gap-2 text-xs text-neutral-500">
            <span className="inline-flex items-center gap-1.5"><GitBranch className="size-3.5" /> verified branch</span>
            <span className="inline-flex items-center gap-1.5"><GitPullRequest className="size-3.5" /> pull request #411</span>
            <span className="inline-flex items-center gap-1.5"><History className="size-3.5" /> default branch main</span>
          </div>
        </section>

        <Surface variant="tertiary" className="rounded-xl border border-neutral-800/70 bg-neutral-950/40 p-3.5">
          <div className="mb-3 flex items-center gap-2">
            <Play className="size-4 text-neutral-400" />
            <Text className="text-sm font-semibold text-neutral-100">Development session</Text>
          </div>
          <Text className="mb-3 block text-sm text-neutral-500">
            Start work from issue <span className="font-mono text-neutral-300">#408</span>.
          </Text>
          <div className="grid gap-2 rounded-lg border border-neutral-800 bg-black/20 p-2">
            <div className="flex items-center gap-2 text-xs text-neutral-400">
              <span className="grid size-5 place-items-center rounded-full bg-emerald-500/15 text-[10px] text-emerald-300">1</span>
              <Text className="font-medium text-neutral-200">Branch</Text>
            </div>
            <div className="flex min-w-0 items-center gap-2 rounded-md bg-neutral-900/70 px-2 py-1.5">
              <GitBranch className="size-3.5 shrink-0 text-neutral-500" />
              <Text className="min-w-0 flex-1 truncate font-mono text-xs text-neutral-200">
                issue-408-show-a-focused-git-graph-around-the-linked-branch-head
              </Text>
            </div>
            <BranchHeadGraphPreview
              comparison={{ result: comparison, state: 'ready' }}
              onOpenHistory={() => undefined}
            />
          </div>
        </Surface>
      </main>
    </div>
  );
}
