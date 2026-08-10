import { useEffect, useMemo, useState } from 'react';
import {
  Bot,
  Circle,
  CircleDot,
  ExternalLink,
  GitBranch,
  GitPullRequestDraft,
  LoaderCircle,
  Monitor
} from 'lucide-react';
import { projectSpaceClient } from '@/api/project-space-client';
import { Button } from '@/app/dotnaos-ui';
import type {
  CodexMachineTaskExistingResult
} from '@/shared/codex-machine-tasks-api';
import type {
  ConnectorOverviewResult,
  GitHubBranchRecord,
  GitHubIssueRecord,
  GitHubPullRequestRecord,
  ProjectSpaceRecord
} from '@/shared/project-space-api';
import { usePullRequestPreviewStatus } from '../hooks/use-pull-request-preview-status';
import { useBranchHeadComparison } from '../hooks/use-branch-head-comparison';
import { codexSessionRoute } from '../../codex-sessions/codex-session-route';
import { BranchHeadGraphPreview } from './branch-head-graph-preview';
import {
  canRunMachineCommand,
  getIssueMachineRows,
  type IssueMachineProjectRow
} from './issue-development-machine-actions';
import {
  canChooseIssueCodingDestination,
  resolveIssueDevelopmentHead
} from './issue-development-head';
import { IssuePullRequestChip } from './issue-branch-menu';
import { connectorLocationPresentation } from './machine-connector-topology-model';
import {
  issueDevelopmentPullRequest,
  shouldShowPullRequestPreview
} from './pull-request-preview-model';
import { PullRequestPreviewStatusView } from './pull-request-preview-status';
import { PullRequestPrototypeAction } from './pull-request-prototype-action';
import {
  clearCodexTaskStartAttempt,
  readOrCreateCodexTaskStartAttempt,
  type CodexTaskStartAttempt
} from './codex-task-start-attempt';
import { CodexTaskStartRecoveryDialog } from './codex-task-start-recovery-dialog';
import { IssueDevelopmentServers } from './issue-development-servers';
import { IssueDevelopmentStart } from './issue-development-start';
import { GitHubCodespaceDestination } from './github-codespace-destination';

interface IssueDevelopmentSessionProps {
  branches: GitHubBranchRecord[];
  connectorOverview: ConnectorOverviewResult;
  issue: GitHubIssueRecord;
  onBranchCreated(branch: GitHubBranchRecord): void;
  onPullRequestCreated(pullRequest: GitHubPullRequestRecord): void;
  project: ProjectSpaceRecord;
  projects: ProjectSpaceRecord[];
  pullRequests: GitHubPullRequestRecord[];
  repoFullName?: string;
  repoUrl?: string;
  targetPath: string;
  onOpenHistory(input: { defaultBranch: string; headBranch: string }): void;
}

export function IssueDevelopmentSession({
  branches,
  connectorOverview,
  issue,
  onBranchCreated,
  onPullRequestCreated,
  project,
  projects,
  pullRequests,
  repoFullName,
  onOpenHistory
}: IssueDevelopmentSessionProps) {
  const [busyMachineId, setBusyMachineId] = useState('');
  const [machineMessage, setMachineMessage] = useState('');
  const [machineError, setMachineError] = useState('');
  const [prototypeMachineId, setPrototypeMachineId] = useState('');
  const [existingTasks, setExistingTasks] = useState<
    Record<string, CodexMachineTaskExistingResult | undefined>
  >({});
  const [checkingExistingTasks, setCheckingExistingTasks] = useState(false);
  const [uncertainStart, setUncertainStart] = useState<{
    attempt: CodexTaskStartAttempt;
    machineName: string;
    row: IssueMachineProjectRow;
  }>();
  const [isRecoveringStart, setIsRecoveringStart] = useState(false);

  useEffect(() => {
    setMachineError('');
    setMachineMessage('');
    setUncertainStart(undefined);
  }, [issue.number]);

  const developmentHead = useMemo(
    () => resolveIssueDevelopmentHead({
      branches,
      issue,
      pullRequests,
      repositoryFullName: repoFullName
    }),
    [branches, issue, pullRequests, repoFullName]
  );
  const selectedBranch =
    developmentHead.state === 'verified' ? developmentHead.branch : undefined;
  const fallbackPullRequest = useMemo(
    () => issueDevelopmentPullRequest({ branches, issue, pullRequests }),
    [branches, issue, pullRequests]
  );
  const selectedPullRequest =
    developmentHead.state === 'verified' && developmentHead.pullRequest
      ? developmentHead.pullRequest
      : fallbackPullRequest?.state !== 'open'
        ? fallbackPullRequest
        : undefined;
  const canChooseDestination = canChooseIssueCodingDestination(developmentHead);
  const machineRows = useMemo<IssueMachineProjectRow[]>(
    () => getIssueMachineRows({ connectorOverview, project, projects, repoFullName }),
    [connectorOverview, project, projects, repoFullName]
  );
  useEffect(() => {
    let cancelled = false;
    if (!repoFullName || machineRows.length === 0) {
      setExistingTasks({});
      setCheckingExistingTasks(false);
      return;
    }
    setCheckingExistingTasks(true);
    void Promise.all(machineRows.map(async (row) => {
      try {
        const result = await projectSpaceClient.getExistingCodexMachineTask({
          connectorId: row.machineId,
          issue: issue.number,
          repositoryId: repoFullName
        });
        return [row.machineId, result] as const;
      } catch {
        return [row.machineId, undefined] as const;
      }
    })).then((entries) => {
      if (cancelled) return;
      setExistingTasks(Object.fromEntries(entries));
      setCheckingExistingTasks(false);
    });
    return () => { cancelled = true; };
  }, [issue.number, machineRows, repoFullName]);
  const localMachineId =
    connectorOverview.machines.find((machine) => machine.connector.status === 'local')?.id ??
    connectorOverview.machines[0]?.id ??
    'local';
  const prototypeMachineRows = useMemo(
    () => machineRows.filter((row) => canRunMachineCommand(row.machine)),
    [machineRows]
  );
  const prototypeMachine = prototypeMachineRows.find(
    (row) => row.machineId === prototypeMachineId
  ) ?? prototypeMachineRows[0];
  const preview = usePullRequestPreviewStatus({
    enabled: Boolean(repoFullName && selectedPullRequest),
    pullRequestNumber: selectedPullRequest?.number,
    repositoryFullName: repoFullName
  });
  const branchComparison = useBranchHeadComparison({
    enabled: Boolean(repoFullName && selectedBranch),
    expectedHeadSha:
      developmentHead.state === 'verified' ? developmentHead.expectedHeadSha : undefined,
    headBranch: selectedBranch?.name,
    repositoryFullName: repoFullName
  });
  useEffect(() => {
    if (
      prototypeMachineId &&
      prototypeMachineRows.some((row) => row.machineId === prototypeMachineId)
    ) {
      return;
    }
    setPrototypeMachineId(prototypeMachineRows[0]?.machineId ?? '');
  }, [prototypeMachineId, prototypeMachineRows]);

  async function startDevelopment(
    row: IssueMachineProjectRow,
    recoveredAttempt?: CodexTaskStartAttempt
  ) {
    if (!selectedBranch || !canChooseDestination) {
      setMachineError('Create or recover a verified linked branch first.');
      return;
    }
    if (!canRunMachineCommand(row.machine)) {
      setMachineError(`${row.machine?.name ?? row.machineId} is not online.`);
      return;
    }
    if (!repoFullName) {
      setMachineError('No GitHub repository is linked.');
      return;
    }
    if (!selectedBranch.commitSha) {
      setMachineError('The exact branch revision is unavailable. Refresh the task and try again.');
      return;
    }
    setBusyMachineId(row.machineId);
    setMachineError('');
    setMachineMessage('');
    const attempt = recoveredAttempt ?? readOrCreateCodexTaskStartAttempt({
      connectorId: row.machineId,
      environmentId: row.environmentId,
      expectedBranch: selectedBranch.name,
      expectedCommit: selectedBranch.commitSha,
      issue: issue.number,
      physicalMachineId: row.physicalMachineId,
      physicalMachineName: row.physicalMachineId ? undefined : row.physicalMachineName,
      repositoryId: repoFullName
    });
    try {
      const result = await projectSpaceClient.startCodexMachineTask(attempt);
      if (result.state === 'confirmed') {
        clearCodexTaskStartAttempt(attempt);
        window.location.assign(codexSessionRoute({
          machineId: result.task.connector.id,
          threadId: result.task.threadId
        }));
        return;
      }
      if (result.state === 'ready') {
        clearCodexTaskStartAttempt(attempt);
        setMachineMessage(`Ready to start on ${result.target.physicalMachine.name}.`);
        return;
      }
      if (result.state === 'blocked') clearCodexTaskStartAttempt(attempt);
      if (result.state === 'uncertain') {
        setUncertainStart({
          attempt,
          machineName: row.physicalMachineName ?? row.machine?.name ?? row.machineId,
          row
        });
        return;
      }
      setMachineError(result.message);
    } catch (error) {
      setMachineError(
        error instanceof Error ? error.message : 'The Codex development task could not be started.'
      );
    } finally {
      setBusyMachineId('');
    }
  }

  async function recoverDevelopmentStart() {
    if (!uncertainStart) return;
    const pending = uncertainStart;
    setIsRecoveringStart(true);
    setMachineError('');
    setMachineMessage('');
    try {
      await projectSpaceClient.recoverCodexMachineTaskStart(pending.attempt);
      setUncertainStart(undefined);
      await startDevelopment(pending.row, pending.attempt);
    } catch (error) {
      setMachineError(
        error instanceof Error ? error.message : 'The unresolved start could not be recovered.'
      );
    } finally {
      setIsRecoveringStart(false);
    }
  }

  function openExistingTask(result: CodexMachineTaskExistingResult) {
    if (result.state === 'attention') {
      setMachineError(result.message);
      return;
    }
    if (result.state !== 'confirmed') return;
    window.location.assign(codexSessionRoute({
      machineId: result.task.connector.id,
      threadId: result.task.threadId
    }));
  }

  const isMerged = selectedPullRequest?.state === 'merged';
  const isReadyPullRequest = selectedPullRequest?.state === 'open' && !selectedPullRequest.isDraft;
  const showsPullRequestPreview = shouldShowPullRequestPreview(selectedPullRequest);
  const canCreatePullRequest = branchComparison.state === 'ready'
    && branchComparison.result.status === 'connected'
    && branchComparison.result.freshness === 'current'
    && (branchComparison.result.aheadBy ?? 0) > 0;
  const hasBranchOnlyDevelopment = Boolean(selectedBranch && !selectedPullRequest);

  return (
    <>
      <div className="grid gap-5">
      {(!canChooseDestination || hasBranchOnlyDevelopment) && !isMerged && issue.state === 'open' ? (
        <IssueDevelopmentStart
          canCreatePullRequest={canCreatePullRequest}
          issue={issue}
          linkedBranch={selectedBranch}
          onBranchReady={onBranchCreated}
          onPullRequestReady={onPullRequestCreated}
          recoveryMessage={developmentHead.state === 'verified'
            ? undefined
            : developmentHead.state === 'none'
              ? undefined
              : developmentHead.message}
          repoFullName={repoFullName}
        />
      ) : null}

      {issue.state === 'closed' && !isMerged ? (
        <p className="text-sm leading-6 text-amber-300">
          This issue is closed without a verified merged pull request. Reopen or reconcile it on GitHub before starting development.
        </p>
      ) : null}

      {selectedPullRequest?.isDraft ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <a className="inline-flex h-8 items-center gap-1.5 rounded-full bg-current/[.045] px-3 text-xs font-medium text-current/55 hover:bg-current/[.075] hover:text-current" href={selectedPullRequest.url} rel="noreferrer" target="_blank">
            <GitPullRequestDraft className="size-3.5" /> Draft #{selectedPullRequest.number}
            <ExternalLink className="size-3" />
          </a>
          <span className="text-xs text-current/35">Active · Draft PR</span>
        </div>
      ) : null}

      {showsPullRequestPreview ? (
        <section className="grid gap-3 border-b border-current/[.08] pb-5">
          <PullRequestPreviewStatusView
            inventory={preview.inventory}
            pullRequest={selectedPullRequest}
            repositoryFullName={repoFullName}
            returnPath={`/projects/${encodeURIComponent(project.id)}/issues/${issue.number}`}
          />
          {isReadyPullRequest && repoFullName ? (
            <div className="grid gap-2">
              <a
                className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-current/[.08] px-3 text-sm font-medium text-current/75 hover:bg-current/[.12] hover:text-current"
                href={selectedPullRequest.url}
                rel="noreferrer"
                target="_blank"
              >
                Approve PR <ExternalLink className="size-3.5" />
              </a>
              <PullRequestPrototypeAction connectorId={prototypeMachine?.machineId} issueNumber={issue.number} projectId={project.id} pullRequest={selectedPullRequest} repositoryFullName={repoFullName} />
            </div>
          ) : null}
        </section>
      ) : null}

      {isMerged ? (
        <section className="grid gap-2">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-xs font-semibold text-current/55">Branch cleanup</h3>
            <span className="text-[10px] text-current/30">Merged task</span>
          </div>
          <div className="flex min-h-11 items-center gap-2 px-1 text-xs">
            <GitBranch className="size-3.5 text-current/30" />
            <span className="min-w-0 flex-1 truncate text-current/55">Remote branch</span>
            <span className={selectedPullRequest.headRefPresent === false ? 'text-emerald-300' : 'text-amber-300'}>
              {selectedPullRequest.headRefPresent === false ? 'Deleted on GitHub' : 'Still on GitHub'}
            </span>
          </div>
          <p className="text-[11px] leading-5 text-current/35">
            Local worktrees are only removable after their Git status has been verified as clean in Repository.
          </p>
        </section>
      ) : null}

      {canChooseDestination && selectedBranch && !isMerged ? (
        <section className="grid gap-5">
          <div>
            <h3 className="text-sm font-semibold text-current/70">Choose coding destination</h3>
            <p className="mt-1 text-xs leading-5 text-current/35">
              The linked branch is ready. Choose where to continue; a Draft PR can follow after the first real commit.
            </p>
          </div>
          <IssueDevelopmentServers
            branchName={selectedBranch.name}
            localMachineId={localMachineId}
            machineRows={machineRows}
            projects={projects}
          />
          <div>
          <div className="mb-2 flex h-8 items-center justify-between">
            <h3 className="text-xs font-semibold text-current/55">Codex</h3>
            <span className="text-[10px] tabular-nums text-current/30">
              {machineRows.length + (repoFullName ? 1 : 0)} destinations
            </span>
          </div>
          <div className="grid gap-1.5">
            {repoFullName ? (
              <GitHubCodespaceDestination
                branch={selectedBranch.name}
                issue={issue.number}
                onStart={({ connectorId, environmentId, name }) => {
                  const machine = connectorOverview.machines.find((candidate) => candidate.id === connectorId);
                  void startDevelopment({ environmentId, machine, machineId: connectorId, physicalMachineName: name });
                }}
                repositoryFullName={repoFullName}
              />
            ) : null}
            {machineRows.map((row) => {
              const hasCheckout = Boolean(row.project);
              const location = row.machine ? connectorLocationPresentation({ connector: row.machine, physicalMachines: connectorOverview.physicalMachines ?? [] }) : undefined;
              const canStart = canRunMachineCommand(row.machine) && Boolean(repoFullName && selectedBranch.commitSha);
              const online = canRunMachineCommand(row.machine);
              const existingTask = existingTasks[row.machineId];
              const hasExistingTask = existingTask?.state === 'confirmed'
                || existingTask?.state === 'attention';
              const existingAction = existingTask?.state === 'confirmed'
                ? existingTask.action === 'open-running'
                  ? 'Open running task'
                  : existingTask.action === 'resolve'
                    ? 'Resolve task problem'
                    : 'Continue task'
                : existingTask?.state === 'attention'
                  ? 'Resolve task problem'
                  : undefined;
              return (
                <div className="flex min-h-11 min-w-0 items-center gap-2 rounded-2xl bg-current/[.04] px-3" key={row.machineId}>
                  {hasCheckout ? <Monitor className="size-3.5 shrink-0 text-current/30" /> : <Bot className="size-3.5 shrink-0 text-current/30" />}
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-current/65">{row.physicalMachineName ?? location?.machineName ?? row.machine?.name ?? row.machineId}</span>
                  <Circle aria-label={online ? 'Online' : 'Offline'} className={`size-2.5 shrink-0 fill-current ${online ? 'text-emerald-400' : 'text-current/20'}`} />
                  <Button
                    isDisabled={(!hasExistingTask && !canStart)
                      || busyMachineId === row.machineId
                      || checkingExistingTasks}
                    size="sm"
                    variant="ghost"
                    onPress={() => hasExistingTask
                      ? openExistingTask(existingTask)
                      : void startDevelopment(row)}
                  >
                    {busyMachineId === row.machineId ? <LoaderCircle className="size-3.5 animate-spin" /> : <Bot className="size-3.5" />}
                    {busyMachineId === row.machineId
                      ? 'Starting…'
                      : checkingExistingTasks
                        ? 'Checking task…'
                        : existingAction ?? 'Start Codex'}
                  </Button>
                </div>
              );
            })}
          </div>
          </div>
        </section>
      ) : null}

      {selectedBranch ? (
        <details className="group border-t border-current/[.08] pt-1">
          <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between text-xs font-medium text-current/35 hover:text-current/65 [&::-webkit-details-marker]:hidden">
            Repository details
            <CircleDot className="size-3.5" />
          </summary>
          <div className="grid gap-3 pb-2">
            <BranchHeadGraphPreview comparison={branchComparison} onOpenHistory={onOpenHistory} />
            <div className="flex items-center gap-2 text-xs text-current/45">
              <GitBranch className="size-3.5" />
              <span className="truncate font-mono">{selectedBranch.name}</span>
            </div>
            {selectedPullRequest ? <IssuePullRequestChip className="max-w-full justify-self-start" pullRequest={selectedPullRequest} /> : null}
          </div>
        </details>
      ) : null}

      {machineMessage ? <p className="text-xs text-emerald-300">{machineMessage}</p> : null}
      {machineError ? <p className="text-xs text-red-300">{machineError}</p> : null}
      </div>
      <CodexTaskStartRecoveryDialog
        isBusy={isRecoveringStart}
        isOpen={Boolean(uncertainStart)}
        machineName={uncertainStart?.machineName ?? 'this machine'}
        onCancel={() => setUncertainStart(undefined)}
        onRetry={() => void recoverDevelopmentStart()}
      />
    </>
  );
}
