import { useEffect, useMemo, useState } from 'react';
import {
  Bot,
  Circle,
  CircleDot,
  ExternalLink,
  GitBranch,
  GitBranchPlus,
  GitPullRequestDraft,
  LoaderCircle,
  Monitor,
  Plus
} from 'lucide-react';
import { projectSpaceClient } from '@/api/project-space-client';
import { Button } from '@/app/dotnaos-ui';
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
import { branchNameForIssue } from './issue-branch-model';
import { resolveIssueDevelopmentHead } from './issue-development-head';
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
  const defaultBranch = branches.find((branch) => branch.isDefault)?.name ?? '';
  const suggestedBranch = branchNameForIssue(issue);
  const [branchName, setBranchName] = useState(suggestedBranch);
  const [showBranchPicker, setShowBranchPicker] = useState(false);
  const [branchError, setBranchError] = useState('');
  const [branchMessage, setBranchMessage] = useState('');
  const [isCreatingBranch, setIsCreatingBranch] = useState(false);
  const [isCreatingPullRequest, setIsCreatingPullRequest] = useState(false);
  const [pullRequestMessage, setPullRequestMessage] = useState('');
  const [pullRequestError, setPullRequestError] = useState('');
  const [busyMachineId, setBusyMachineId] = useState('');
  const [machineMessage, setMachineMessage] = useState('');
  const [prototypeMachineId, setPrototypeMachineId] = useState('');
  const [uncertainStart, setUncertainStart] = useState<{
    attempt: CodexTaskStartAttempt;
    machineName: string;
    row: IssueMachineProjectRow;
  }>();
  const [isRecoveringStart, setIsRecoveringStart] = useState(false);

  useEffect(() => {
    setBranchName(suggestedBranch);
    setBranchError('');
    setBranchMessage('');
    setPullRequestError('');
    setPullRequestMessage('');
    setUncertainStart(undefined);
  }, [issue.number, suggestedBranch]);

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
      : fallbackPullRequest;
  const visibleBranches = useMemo(
    () => branches
      .filter((branch) => !branch.isDefault)
      .filter((branch) => !branch.linkedIssueNumbers?.includes(issue.number))
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, 6),
    [branches, issue.number]
  );
  const machineRows = useMemo<IssueMachineProjectRow[]>(
    () => getIssueMachineRows({ connectorOverview, project, projects, repoFullName }),
    [connectorOverview, project, projects, repoFullName]
  );
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

  async function createBranch(branchNameOverride?: string) {
    if (!repoFullName) {
      setBranchError('No GitHub repository is linked.');
      return;
    }
    const trimmedBranchName = (branchNameOverride ?? branchName).trim();
    if (!trimmedBranchName) {
      setBranchError('Branch name is required.');
      return;
    }
    const existingBranch = branches.find((branch) => branch.name === trimmedBranchName);
    if (!existingBranch && !defaultBranch) {
      setBranchError('The repository default branch is unavailable.');
      return;
    }
    setIsCreatingBranch(true);
    setBranchError('');
    setBranchMessage('');
    try {
      const result = await projectSpaceClient.createGitHubBranch({
        fullName: repoFullName,
        issueNumber: issue.number,
        name: trimmedBranchName,
        sourceBranch: existingBranch?.name ?? defaultBranch
      });
      if (result.status !== 'connected' || !result.branch) {
        setBranchError(result.message ?? 'Could not create branch.');
        return;
      }
      onBranchCreated(result.branch);
      setShowBranchPicker(false);
      setBranchMessage('Linked branch created.');
    } catch (error) {
      setBranchError(
        error instanceof Error ? error.message : 'Could not create branch.'
      );
    } finally {
      setIsCreatingBranch(false);
    }
  }

  async function createPullRequest() {
    if (selectedPullRequest) {
      setPullRequestError('A pull request is already linked.');
      return;
    }
    if (!defaultBranch) {
      setPullRequestError('The repository default branch is unavailable.');
      return;
    }
    if (!repoFullName || !selectedBranch) {
      setPullRequestError('Link a branch first.');
      return;
    }
    setIsCreatingPullRequest(true);
    setPullRequestError('');
    setPullRequestMessage('');
    try {
      const comparison = await projectSpaceClient.getGitHubBranchComparison({
        fullName: repoFullName,
        headBranch: selectedBranch.name,
        limit: 1
      });
      if (
        comparison.status !== 'connected' ||
        comparison.freshness !== 'current' ||
        typeof comparison.aheadBy !== 'number'
      ) {
        setPullRequestError(
          comparison.message ?? 'The branch could not be checked before creating the pull request.'
        );
        return;
      }
      if (comparison.aheadBy < 1) {
        setPullRequestError(
          'The branch has no commits yet. Start or continue development first.'
        );
        return;
      }
      const result = await projectSpaceClient.createGitHubPullRequest({
        baseBranch: defaultBranch,
        body: issue.body,
        draft: true,
        fullName: repoFullName,
        headBranch: selectedBranch.name,
        issueNumber: issue.number,
        title: issue.title
      });
      if (result.status !== 'connected' || !result.pullRequest) {
        setPullRequestError(result.message ?? 'Could not create pull request.');
        return;
      }
      onPullRequestCreated(result.pullRequest);
      setPullRequestMessage(`Pull request #${result.pullRequest.number} created.`);
    } catch (error) {
      setPullRequestError(
        error instanceof Error ? error.message : 'Could not create pull request.'
      );
    } finally {
      setIsCreatingPullRequest(false);
    }
  }

  async function startDevelopment(
    row: IssueMachineProjectRow,
    recoveredAttempt?: CodexTaskStartAttempt
  ) {
    if (!selectedBranch) {
      setMachineMessage('Link a branch first.');
      return;
    }
    if (!canRunMachineCommand(row.machine)) {
      setMachineMessage(`${row.machine?.name ?? row.machineId} is not online.`);
      return;
    }
    if (!repoFullName) {
      setMachineMessage('No GitHub repository is linked.');
      return;
    }
    if (!selectedBranch.commitSha) {
      setMachineMessage('The exact branch revision is unavailable. Refresh the task and try again.');
      return;
    }
    setBusyMachineId(row.machineId);
    setMachineMessage('');
    const attempt = recoveredAttempt ?? readOrCreateCodexTaskStartAttempt({
      connectorId: row.machineId,
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
      setMachineMessage(result.message);
    } catch (error) {
      setMachineMessage(
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
    setMachineMessage('');
    try {
      await projectSpaceClient.recoverCodexMachineTaskStart(pending.attempt);
      setUncertainStart(undefined);
      await startDevelopment(pending.row, pending.attempt);
    } catch (error) {
      setMachineMessage(
        error instanceof Error ? error.message : 'The unresolved start could not be recovered.'
      );
    } finally {
      setIsRecoveringStart(false);
    }
  }

  const isMerged = selectedPullRequest?.state === 'merged';
  const isReadyPullRequest = selectedPullRequest?.state === 'open' && !selectedPullRequest.isDraft;
  const showsPullRequestPreview = shouldShowPullRequestPreview(selectedPullRequest);

  return (
    <>
      <div className="grid gap-5">
      {!selectedBranch && !isMerged ? (
        <section className="grid gap-3">
          <p className="text-sm leading-6 text-current/45">
            Development has not started. Create the task branch when the plan is ready.
          </p>
          <Button className="w-full" onPress={() => setShowBranchPicker(true)}>
            <GitBranchPlus className="size-4" /> Start development
          </Button>
        </section>
      ) : null}

      {showBranchPicker ? (
        <section className="issue-rise-in grid gap-3 rounded-2xl bg-current/[.04] p-3">
          {visibleBranches.length ? (
            <div className="grid gap-1">
              <p className="px-1 text-[11px] font-medium text-current/35">Use an existing branch</p>
              {visibleBranches.map((branch) => (
                <button className="flex min-w-0 items-center gap-2 rounded-xl px-2 py-2 text-left text-xs text-current/60 hover:bg-current/[.05] hover:text-current" key={branch.name} onClick={() => void createBranch(branch.name)} type="button">
                  <GitBranch className="size-3.5 shrink-0" />
                  <span className="truncate font-mono">{branch.name}</span>
                </button>
              ))}
            </div>
          ) : null}
          <label className="grid gap-1.5">
            <span className="px-1 text-[11px] font-medium text-current/35">New branch</span>
            <input className="h-10 rounded-xl bg-current/[.055] px-3 font-mono text-xs text-current outline-none ring-1 ring-inset ring-current/[.07] focus:ring-blue-400/60" onChange={(event) => setBranchName(event.currentTarget.value)} value={branchName} />
          </label>
          <div className="flex gap-2">
            <Button className="flex-1" size="sm" variant="ghost" onPress={() => setShowBranchPicker(false)}>Cancel</Button>
            <Button className="flex-1" isDisabled={isCreatingBranch || !repoFullName || !branchName.trim() || !defaultBranch} size="sm" onPress={() => void createBranch()}>
              <Plus className="size-4" /> {isCreatingBranch ? 'Creating…' : 'Create'}
            </Button>
          </div>
        </section>
      ) : null}

      {selectedBranch && !selectedPullRequest ? (
        <section className="grid gap-3">
          <div className="flex min-w-0 items-center gap-2 rounded-full bg-current/[.04] px-3 py-2 text-xs text-current/55">
            <GitBranch className="size-3.5 shrink-0" />
            <span className="truncate font-mono">{selectedBranch.name}</span>
          </div>
          <p className="text-xs leading-5 text-current/40">
            Start Codex on a machine below. Create the draft pull request after the first commit.
          </p>
          <Button className="w-full" isDisabled={!repoFullName || !defaultBranch || isCreatingPullRequest} variant="secondary" onPress={() => void createPullRequest()}>
            <GitPullRequestDraft className="size-4" /> {isCreatingPullRequest ? 'Creating…' : 'Create draft PR'}
          </Button>
        </section>
      ) : null}

      {selectedPullRequest?.isDraft ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <a className="inline-flex h-8 items-center gap-1.5 rounded-full bg-current/[.045] px-3 text-xs font-medium text-current/55 hover:bg-current/[.075] hover:text-current" href={selectedPullRequest.url} rel="noreferrer" target="_blank">
            <GitPullRequestDraft className="size-3.5" /> Draft #{selectedPullRequest.number}
            <ExternalLink className="size-3" />
          </a>
          <span className="text-xs text-current/35">Continue development below</span>
        </div>
      ) : null}

      {showsPullRequestPreview ? (
        <section className="grid gap-3 border-b border-current/[.08] pb-5">
          <PullRequestPreviewStatusView inventory={preview.inventory} pullRequest={selectedPullRequest} repositoryFullName={repoFullName} />
          {isReadyPullRequest && repoFullName ? (
            <PullRequestPrototypeAction connectorId={prototypeMachine?.machineId} issueNumber={issue.number} projectId={project.id} pullRequest={selectedPullRequest} repositoryFullName={repoFullName} />
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

      {selectedBranch && !isMerged ? (
        <IssueDevelopmentServers
          branchName={selectedBranch.name}
          localMachineId={localMachineId}
          machineRows={machineRows}
          projects={projects}
        />
      ) : null}

      {selectedBranch && !isMerged ? (
        <section>
          <div className="mb-2 flex h-8 items-center justify-between">
            <h3 className="text-xs font-semibold text-current/55">Codex</h3>
            <span className="text-[10px] tabular-nums text-current/30">
              {machineRows.length} {machineRows.length === 1 ? 'machine' : 'machines'}
            </span>
          </div>
          <div className="grid gap-1.5">
            {machineRows.map((row) => {
              const hasCheckout = Boolean(row.project);
              const location = row.machine ? connectorLocationPresentation({ connector: row.machine, physicalMachines: connectorOverview.physicalMachines ?? [] }) : undefined;
              const canStart = canRunMachineCommand(row.machine) && Boolean(repoFullName && selectedBranch.commitSha);
              const online = canRunMachineCommand(row.machine);
              return (
                <div className="flex min-h-11 min-w-0 items-center gap-2 rounded-2xl bg-current/[.04] px-3" key={row.machineId}>
                  {hasCheckout ? <Monitor className="size-3.5 shrink-0 text-current/30" /> : <Bot className="size-3.5 shrink-0 text-current/30" />}
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-current/65">{row.physicalMachineName ?? location?.machineName ?? row.machine?.name ?? row.machineId}</span>
                  <Circle aria-label={online ? 'Online' : 'Offline'} className={`size-2.5 shrink-0 fill-current ${online ? 'text-emerald-400' : 'text-current/20'}`} />
                  <Button isDisabled={!canStart || busyMachineId === row.machineId} size="sm" variant="ghost" onPress={() => void startDevelopment(row)}>
                    {busyMachineId === row.machineId ? <LoaderCircle className="size-3.5 animate-spin" /> : <Bot className="size-3.5" />}
                    {busyMachineId === row.machineId ? 'Starting…' : 'Start Codex'}
                  </Button>
                </div>
              );
            })}
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

      {branchMessage || pullRequestMessage || machineMessage ? <p className="text-xs text-emerald-300">{branchMessage || pullRequestMessage || machineMessage}</p> : null}
      {branchError || pullRequestError ? <p className="text-xs text-red-300">{branchError || pullRequestError}</p> : null}
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
