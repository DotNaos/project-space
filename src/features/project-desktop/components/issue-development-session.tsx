import { useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  Download,
  GitBranch,
  GitBranchPlus,
  Monitor,
  Play,
  Rocket
} from 'lucide-react';
import { projectSpaceClient } from '@/api/project-space-client';
import { Button, Surface, Text } from '@/app/dotnaos-ui';
import type {
  ConnectorOverviewResult,
  GitHubBranchRecord,
  GitHubIssueRecord,
  GitHubPullRequestRecord,
  ProjectSpaceRecord
} from '@/shared/project-space-api';
import { usePullRequestPreviewStatus } from '../hooks/use-pull-request-preview-status';
import {
  canRunMachineCommand,
  cloneUrl,
  createStartDevelopmentCommand,
  getIssueMachineRows,
  machineStatusClass,
  relativeClonePath,
  repositoryNameFromProject,
  type IssueMachineProjectRow
} from './issue-development-machine-actions';
import { branchNameForIssue, issueBranchesForIssue } from './issue-branch-model';
import { IssuePullRequestChip } from './issue-branch-menu';
import { connectorLocationPresentation } from './machine-connector-topology-model';
import { issueDevelopmentPullRequest } from './pull-request-preview-model';
import { PullRequestPreviewStatusView } from './pull-request-preview-status';
import { MachineResourceSummary } from './machine-resource-usage';

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
}

function StepHeading({ complete = false, number, title }: {
  complete?: boolean;
  number: number;
  title: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-neutral-700 text-[11px] text-neutral-400">
        {number}
      </span>
      <Text className="min-w-0 flex-1 text-xs font-medium text-neutral-300">{title}</Text>
      {complete ? <CheckCircle2 className="size-3.5 text-emerald-300" /> : null}
    </div>
  );
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
  repoUrl,
  targetPath
}: IssueDevelopmentSessionProps) {
  const defaultBranch = branches.find((branch) => branch.isDefault)?.name ?? 'main';
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

  useEffect(() => {
    setBranchName(suggestedBranch);
    setBranchError('');
    setBranchMessage('');
    setPullRequestError('');
    setPullRequestMessage('');
  }, [issue.number, suggestedBranch]);

  const linkedBranches = useMemo(
    () => issueBranchesForIssue({ branches, issue }),
    [branches, issue]
  );
  const selectedBranch = linkedBranches[0];
  const selectedPullRequest = useMemo(
    () => issueDevelopmentPullRequest({ branches, issue, pullRequests }),
    [branches, issue, pullRequests]
  );
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
  const preview = usePullRequestPreviewStatus({
    enabled: Boolean(repoFullName && selectedPullRequest),
    pullRequestNumber: selectedPullRequest?.number,
    repositoryFullName: repoFullName
  });
  const repositoryCloneUrl = cloneUrl(repoFullName, repoUrl);
  const repositoryName = repositoryNameFromProject(project, repoFullName);
  const fallbackRelativePath = relativeClonePath(targetPath || project.rootPath, repositoryName);

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
    } finally {
      setIsCreatingBranch(false);
    }
  }

  async function createPullRequest() {
    if (!repoFullName || !selectedBranch || selectedPullRequest) {
      setPullRequestError(selectedPullRequest ? 'A pull request is already linked.' : 'Link a branch first.');
      return;
    }
    setIsCreatingPullRequest(true);
    setPullRequestError('');
    setPullRequestMessage('');
    try {
      const result = await projectSpaceClient.createGitHubPullRequest({
        baseBranch: defaultBranch,
        body: issue.body,
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
    } finally {
      setIsCreatingPullRequest(false);
    }
  }

  async function startDevelopment(row: IssueMachineProjectRow) {
    if (!selectedBranch) {
      setMachineMessage('Link a branch first.');
      return;
    }
    if (!canRunMachineCommand(row.machine)) {
      setMachineMessage(`${row.machine?.name ?? row.machineId} is not online.`);
      return;
    }
    if (!row.project && !repositoryCloneUrl) {
      setMachineMessage('No clone URL is available for this repository.');
      return;
    }
    setBusyMachineId(row.machineId);
    setMachineMessage('');
    try {
      const result = await projectSpaceClient.runMachineTerminalCommand({
        command: createStartDevelopmentCommand({
          branchName: selectedBranch.name,
          projectPath: row.project?.rootPath,
          relativePath: fallbackRelativePath,
          repository: repositoryCloneUrl
        }),
        machineId: row.machineId
      });
      setMachineMessage(
        result.exitCode === 0
          ? result.stdout.trim() || `Started ${selectedBranch.name} on ${row.machine?.name ?? row.machineId}.`
          : result.stderr || result.stdout || `Could not start development on ${row.machine?.name ?? row.machineId}.`
      );
    } finally {
      setBusyMachineId('');
    }
  }

  return (
    <Surface variant="tertiary" className="rounded-xl border border-neutral-800/70 bg-neutral-950/40 p-3.5">
      <div className="mb-3 flex items-center gap-2">
        <Play className="size-4 text-neutral-400" />
        <Text className="text-sm font-semibold text-neutral-100">Development session</Text>
      </div>
      <Text className="mb-3 block text-sm text-neutral-500">
        Start work from issue <span className="font-mono text-neutral-300">#{issue.number}</span>.
      </Text>
      <div className="grid gap-2">
        <div className="grid gap-2 rounded-lg border border-neutral-800 bg-black/20 p-2">
          <StepHeading complete={Boolean(selectedBranch)} number={1} title="Branch" />
          {selectedBranch ? (
            <div className="flex min-w-0 items-center gap-2 rounded-md bg-neutral-900/70 px-2 py-1.5">
              <GitBranch className="size-3.5 shrink-0 text-neutral-500" />
              <Text className="min-w-0 flex-1 truncate font-mono text-xs text-neutral-200">{selectedBranch.name}</Text>
            </div>
          ) : <Text className="text-xs text-neutral-500">No branch linked yet.</Text>}
          <Button size="sm" variant="ghost" isDisabled={Boolean(selectedBranch)} className="justify-start" onPress={() => setShowBranchPicker((value) => !value)}>
            <GitBranchPlus className="size-4" />Create linked branch
          </Button>
          {showBranchPicker ? (
            <div className="issue-rise-in grid gap-2 border-t border-neutral-800 pt-2">
              {visibleBranches.length ? <div className="grid gap-1">
                <Text className="text-xs text-neutral-500">Existing branches</Text>
                {visibleBranches.map((branch) => <button key={branch.name} type="button" onClick={() => { setBranchName(branch.name); void createBranch(branch.name); }} className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-neutral-300 transition hover:bg-neutral-900 hover:text-neutral-50">
                  <GitBranch className="size-3 shrink-0 text-neutral-500" /><span className="min-w-0 truncate font-mono">{branch.name}</span>
                </button>)}
              </div> : null}
              <label className="grid gap-1">
                <Text className="text-xs text-neutral-500">Branch name</Text>
                <input value={branchName} onChange={(event) => setBranchName(event.currentTarget.value)} className="h-8 rounded-md border border-neutral-800 bg-neutral-950 px-2 font-mono text-xs text-neutral-100 outline-none transition focus:border-neutral-600" />
              </label>
              <Button size="sm" isDisabled={isCreatingBranch || !repoFullName || !branchName.trim()} onPress={() => void createBranch()}>
                <GitBranchPlus className="size-4" />{isCreatingBranch ? 'Creating…' : 'Create linked branch'}
              </Button>
            </div>
          ) : null}
          {branchMessage ? <Text className="text-xs text-emerald-300">{branchMessage}</Text> : null}
          {branchError ? <Text className="text-xs text-red-300">{branchError}</Text> : null}
        </div>

        <div className="grid gap-2 rounded-lg border border-neutral-800 bg-black/20 p-2">
          <StepHeading complete={Boolean(selectedPullRequest)} number={2} title="Pull request" />
          {selectedPullRequest ? (
            <IssuePullRequestChip className="max-w-full justify-self-start" pullRequest={selectedPullRequest} />
          ) : (
            <Button variant="secondary" isDisabled={!selectedBranch || !repoFullName || isCreatingPullRequest} onPress={() => void createPullRequest()}>
              <Rocket className="size-4" />{isCreatingPullRequest ? 'Creating PR…' : 'Create PR'}
            </Button>
          )}
          {pullRequestMessage ? <Text className="text-xs text-emerald-300">{pullRequestMessage}</Text> : null}
          {pullRequestError ? <Text className="text-xs text-red-300">{pullRequestError}</Text> : null}
        </div>

        <div className="grid gap-2 rounded-lg border border-neutral-800 bg-black/20 p-2">
          <StepHeading number={3} title="Preview deployment" />
          <PullRequestPreviewStatusView inventory={preview.inventory} pullRequest={selectedPullRequest} repositoryFullName={repoFullName} />
        </div>

        <div className="grid gap-2 rounded-lg border border-neutral-800 bg-black/20 p-2">
          <StepHeading number={4} title="Start development" />
          {machineRows.length ? <div className="grid gap-1">{machineRows.map((row) => {
            const hasCheckout = Boolean(row.project);
            const location = row.machine ? connectorLocationPresentation({ connector: row.machine, physicalMachines: connectorOverview.physicalMachines ?? [] }) : undefined;
            const canStart = Boolean(selectedBranch) && canRunMachineCommand(row.machine) && (hasCheckout || Boolean(repositoryCloneUrl));
            return <button key={row.machineId} type="button" disabled={!canStart || busyMachineId === row.machineId} onClick={() => void startDevelopment(row)} className="flex min-h-10 min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-neutral-300 transition hover:bg-neutral-900 hover:text-neutral-50 disabled:pointer-events-none disabled:opacity-45">
              {hasCheckout ? <Monitor className="size-3.5 shrink-0 text-neutral-500" /> : <Download className="size-3.5 shrink-0 text-neutral-500" />}
              <span className="min-w-0 flex-1"><span className="block truncate">{busyMachineId === row.machineId ? 'Starting…' : location?.machineName ?? row.machineId}</span>{location && busyMachineId !== row.machineId ? <span className="block truncate text-[11px] text-neutral-500">{location.connectorLabel}</span> : null}{row.machine && busyMachineId !== row.machineId ? <MachineResourceSummary resources={row.machine.resources} /> : null}</span>
              <span className={machineStatusClass(row.machine?.connector.status)}>{hasCheckout ? 'open' : 'clone'}</span>
            </button>;
          })}</div> : <Text className="text-xs text-neutral-500">No connector installations registered.</Text>}
          {machineMessage ? <Text className="text-xs text-neutral-500">{machineMessage}</Text> : null}
        </div>

        <div className="grid gap-2 rounded-lg border border-neutral-800 bg-black/20 p-2">
          <StepHeading number={5} title="Run tests" />
          <Button variant="ghost" isDisabled><Play className="size-4" />Run tests</Button>
        </div>
      </div>
    </Surface>
  );
}
