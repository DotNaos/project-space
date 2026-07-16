import { ChevronRight } from 'lucide-react';
import { Disclosure } from '@heroui/react';
import { Chip, Text } from '@/app/dotnaos-ui';
import type { MachineRecord } from '@/shared/project-space-api';
import { cn } from '@/lib/utils';
import type { MachineWorktreeState } from '../hooks/use-machine-worktree-discovery';
import { ConnectorChannelChip } from './connector-channel-chip';
import { MachineConnectorActionsMenu } from './machine-connector-actions-menu';
import { runtimeVersionLabel } from './machine-connector-runtime-model';
import { MachineConnectionIcon, MachineOsMark } from './machine-visuals';
import type { MachineProjectCheckout } from './project-machine-checkout-model';
import { ProjectMachineBranches } from './project-machine-branches';
import type { WorktreeBranchOption } from './worktree-branch-list';
import { connectorStatusClass } from './project-connector-inventory-model';

interface ProjectConnectorDisclosureProps {
  branches: WorktreeBranchOption[];
  busyBranchName: string;
  canClone: boolean;
  checkouts: MachineProjectCheckout[];
  connector?: MachineRecord;
  connectorId: string;
  defaultBranch: string;
  defaultExpanded?: boolean;
  environmentLabel?: string;
  onCloneBranch(branchName: string): void;
  onOpenConnector(): void;
  onSelectBase(): void;
  onSelectBranch(branchName: string, path?: string): void;
  onSelectWorktree(worktreeId: string): void;
  projectName: string;
  repositoryMessage?: string;
  state?: MachineWorktreeState;
  targetError?: string;
  targetCheckPending: boolean;
}

export function ProjectConnectorDisclosure({
  branches,
  busyBranchName,
  canClone,
  checkouts,
  connector,
  connectorId,
  defaultBranch,
  defaultExpanded,
  environmentLabel,
  onCloneBranch,
  onOpenConnector,
  onSelectBase,
  onSelectBranch,
  onSelectWorktree,
  projectName,
  repositoryMessage,
  state,
  targetError,
  targetCheckPending
}: ProjectConnectorDisclosureProps) {
  const worktreeCount = state?.state === 'ready' ? state.worktrees.length : 0;
  const hasCheckout = checkouts.length > 0;
  const checkoutLabel = hasCheckout
    ? 'checkout'
    : targetCheckPending
      ? 'checking target'
      : 'not cloned';
  const identity = environmentLabel || 'Environment not reported';

  return (
    <Disclosure
      defaultExpanded={defaultExpanded}
      className="min-w-0 border-t border-neutral-900 first:border-t-0"
    >
      <Disclosure.Heading className="grid min-w-0 grid-cols-[minmax(0,1fr)_2.75rem] items-stretch hover:bg-neutral-900/35">
        <Disclosure.Trigger
          aria-label={`Show worktrees for ${identity} connector`}
          className="group grid min-h-11 min-w-0 grid-cols-[auto_minmax(0,1fr)_2.75rem] items-start gap-2 px-3 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-400/60 sm:px-4"
        >
          <span className="flex items-center gap-1.5 pt-0.5">
            {connector ? <MachineConnectionIcon machine={connector} /> : null}
            {connector ? <MachineOsMark machine={connector} /> : null}
          </span>
          <span className="min-w-0">
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
              <Text className="text-sm font-semibold text-neutral-100">{identity}</Text>
              {connector ? <ConnectorChannelChip machine={connector} /> : null}
              <Chip
                size="sm"
                className={cn(
                  'rounded-full px-2 py-0.5',
                  connectorStatusClass(connector?.connector.status)
                )}
              >
                {connector?.connector.status ?? 'unknown'}
              </Chip>
            </span>
            <span className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
              {connector?.connector.runtime ? (
                <Chip size="sm" className="rounded-full px-2 py-0.5 text-neutral-400">
                  {runtimeVersionLabel(connector)}
                </Chip>
              ) : null}
              <Chip
                size="sm"
                className={cn(
                  'rounded-full px-2 py-0.5',
                  hasCheckout ? 'text-sky-300' : 'text-neutral-500'
                )}
              >
                {checkoutLabel}
              </Chip>
              {state?.state === 'ready' ? (
                <Chip size="sm" className="rounded-full px-2 py-0.5 text-neutral-400">
                  {worktreeCount} {worktreeCount === 1 ? 'worktree' : 'worktrees'}
                </Chip>
              ) : state?.state === 'proven-empty' ? (
                <Chip size="sm" className="rounded-full px-2 py-0.5 text-neutral-500">
                  no worktrees
                </Chip>
              ) : null}
            </span>
            <Text className="mt-1 block truncate text-xs text-neutral-500">
              {checkouts[0]?.path || connector?.name || connectorId}
            </Text>
          </span>
          <span className="flex min-h-11 items-center justify-center self-center">
            <Disclosure.Indicator className="size-4 text-neutral-500 transition-transform group-aria-expanded:rotate-90 motion-reduce:transition-none">
              <ChevronRight />
            </Disclosure.Indicator>
          </span>
        </Disclosure.Trigger>
        <span className="flex min-h-11 items-start justify-center pt-2.5">
          {connector ? (
            <MachineConnectorActionsMenu machine={connector} />
          ) : null}
        </span>
      </Disclosure.Heading>
      <Disclosure.Content>
        <Disclosure.Body className="min-w-0 bg-neutral-950/45 px-3 pb-4 pt-2 sm:px-4">
          {connector ? (
            <button
              className="mb-3 text-xs text-neutral-500 hover:text-neutral-300"
              type="button"
              onClick={onOpenConnector}
            >
              Open connector details
            </button>
          ) : null}
          {!state && hasCheckout ? (
            <Text className="mb-3 block text-xs text-neutral-500">Checking worktrees…</Text>
          ) : null}
          {state?.state === 'blocked' ? (
            <Text className="mb-3 block text-xs text-red-300/80">
              Worktree discovery blocked: {state.error}
            </Text>
          ) : null}
          {branches.length > 0 ? (
            <ProjectMachineBranches
              busyBranchName={busyBranchName}
              canClone={canClone}
              cloneMessage={connector?.connector.status === 'local' || connector?.connector.status === 'online' ? 'Clone' : 'Offline'}
              defaultBranch={defaultBranch}
              localPathLabel="Local"
              onCloneBranch={onCloneBranch}
              onSelectBase={onSelectBase}
              onSelectBranch={onSelectBranch}
              onSelectWorktree={onSelectWorktree}
              options={branches}
              projectName={projectName}
              selectedValue=""
              showMissingPath={false}
            />
          ) : (
            <Text className="block rounded-lg border border-neutral-900 px-3 py-3 text-sm text-neutral-500">
              No GitHub branches found for this repository.
            </Text>
          )}
          {targetError || repositoryMessage ? (
            <Text className="mt-3 block text-xs text-neutral-500">
              {targetError || repositoryMessage}
            </Text>
          ) : null}
        </Disclosure.Body>
      </Disclosure.Content>
    </Disclosure>
  );
}
