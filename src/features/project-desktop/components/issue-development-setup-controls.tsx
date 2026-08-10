import { LoaderCircle, PackageCheck, RotateCcw } from 'lucide-react';

import { Button } from '@/app/dotnaos-ui';
import { useWorktreeSetup } from '../hooks/use-worktree-setup';
import { hasPendingWorktreeSetup } from '../hooks/worktree-setup-state';
import { issueDevelopmentSetupState } from './issue-development-server-model';

export type IssueSetupRuntime = Pick<
  ReturnType<typeof useWorktreeSetup>,
  'errors' | 'isChecking' | 'pendingKeys' | 'prepare' | 'results'
>;

export function setupStateForWorktree(setup: IssueSetupRuntime, worktreeId: string) {
  return issueDevelopmentSetupState({
    error: setup.errors.get(worktreeId),
    isChecking: setup.isChecking,
    result: setup.results.get(worktreeId)
  });
}

export function IssueDevelopmentSetupControls({
  canManage,
  label,
  onAfterPrepare,
  setup,
  worktreeIds
}: {
  canManage: boolean;
  label?: string;
  onAfterPrepare(): Promise<unknown> | unknown;
  setup: IssueSetupRuntime;
  worktreeIds: string[];
}) {
  return worktreeIds.map((worktreeId) => {
    const state = setupStateForWorktree(setup, worktreeId);
    if (state.kind === 'ready') return null;
    const isPending = hasPendingWorktreeSetup(setup.pendingKeys, worktreeId);
    const isActive = isPending || state.kind === 'checking' || state.kind === 'running';

    async function prepare() {
      if (!state.setupStepId || !state.action || isPending) return;
      await setup.prepare(worktreeId, state.setupStepId);
      await onAfterPrepare();
    }

    return (
      <div
        aria-live="polite"
        className="flex min-h-8 min-w-0 items-center gap-2 px-2 py-1"
        key={worktreeId}
      >
        {isActive ? (
          <LoaderCircle className="size-3 shrink-0 animate-spin text-blue-300/70" />
        ) : (
          <span className={`size-2 shrink-0 rounded-full ${state.kind === 'failed' || state.kind === 'error' ? 'bg-red-400' : 'bg-amber-300'}`} />
        )}
        <span className={`min-w-0 flex-1 text-[11px] leading-4 ${state.kind === 'failed' || state.kind === 'error' ? 'text-red-300/80' : 'text-current/40'}`}>
          {label ? `${label} · ` : ''}{state.message}
        </span>
        {canManage && state.action && state.setupStepId ? (
          <Button
            className="h-7 min-h-7 shrink-0 rounded-full px-2.5"
            isDisabled={isPending}
            size="sm"
            title={state.setupStepId}
            variant="ghost"
            onPress={() => void prepare()}
          >
            {isPending ? (
              <LoaderCircle className="size-3 animate-spin" />
            ) : state.action === 'retry' ? (
              <RotateCcw className="size-3" />
            ) : (
              <PackageCheck className="size-3" />
            )}
            {state.action === 'retry' ? 'Retry setup' : 'Run setup'}
          </Button>
        ) : null}
      </div>
    );
  });
}
