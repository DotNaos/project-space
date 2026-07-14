import type {
  GitHubBranchRecord,
  GitHubIssueRecord,
  GitHubPullRequestRecord,
  MachineRecord,
  ProjectSpaceRecord,
  ProjectWorktreeDiscoveryState,
  ProjectWorktreeRecord
} from '@/shared/project-space-api';
import type {
  CodexSessionReadResult,
  CodexSessionListResult,
  CodexSessionRecord
} from '@/shared/codex-sessions-api';
import type {
  ProjectTopologyInventory,
  TopologyBrowserCapability,
  TopologyInventoryResult,
  TopologyMachine,
  TopologyMultiMachineState,
  TopologyProject,
  TopologyTaskActivity,
  TopologyTaskDelivery,
  TopologyTaskEvidence,
  TopologyTaskWriteCapability,
  TopologyTranscriptItem,
  TopologyTruthState,
  TopologyWorktreeInventory
} from './project-topology-types';

const clockSkewToleranceMs = 30_000;
import { validTopologyRuntimeId } from './project-topology-runtime-id';

const unavailableBrowser: TopologyBrowserCapability = {
  reason: 'No safe browser-session transport is available for this task.',
  state: 'unavailable'
};

export function resolveIssue(
  branches: GitHubBranchRecord[],
  issues: GitHubIssueRecord[],
  branchName: string | undefined,
  taskTitle: string
) {
  const branch = branches.find((candidate) => sameBranch(candidate.name, branchName));
  const linkedNumbers = [...new Set(branch?.linkedIssueNumbers ?? [])];
  const titleNumber = Number(taskTitle.match(/(?:^|\s)#(\d+)(?:\s|·|:|-|$)/)?.[1]);
  const number = linkedNumbers.length === 1
    ? linkedNumbers[0]
    : Number.isSafeInteger(titleNumber)
      && titleNumber > 0
      && (linkedNumbers.length === 0 || linkedNumbers.includes(titleNumber))
      ? titleNumber
      : undefined;
  const issue = issues.find((candidate) => candidate.number === number);
  return issue ? {
    number: issue.number,
    state: issue.state,
    title: issue.title,
    url: issue.url
  } : undefined;
}

export function resolveDelivery(
  pullRequests: GitHubPullRequestRecord[],
  deployment: TopologyInventoryResult<import('@/shared/project-space-api').DeployedEnvironmentStatusResult> | undefined,
  repositoryFullName: string | undefined,
  branchName: string | undefined,
  headSha: string | undefined,
  session: CodexSessionRecord,
  evidence: TopologyTaskEvidence | undefined,
  snapshotCheckedAt: string
): TopologyTaskDelivery {
  const issueNumber = issueNumberFromTitle(session.title);
  const deliveryEvidence = evidenceMatchesSession(evidence, session)
    ? evidence.delivery
    : undefined;
  const merged = branchName
    && headSha
    && issueNumber
    && deliveryEvidence
    && deliveryEvidence.source === 'github-pull-request'
    && deliveryEvidence.sessionLastActivityAt === session.lastActivityAt
    && sameBranch(deliveryEvidence.branchName, branchName)
    && sameSha(deliveryEvidence.headSha, headSha)
    && validCommitSha(headSha)
    && validCommitSha(deliveryEvidence.mergeCommitHash)
    && validEvidenceWindow(
      session.lastActivityAt,
      deliveryEvidence.observedAt,
      snapshotCheckedAt
    )
    ? pullRequests.find((pullRequest) => (
        pullRequest.state === 'merged'
        && pullRequest.number === deliveryEvidence.pullRequestNumber
        && sameBranch(pullRequest.headBranch, branchName)
        && pullRequest.linkedIssueNumbers?.includes(issueNumber)
        && sameSha(pullRequest.mergeCommitHash, deliveryEvidence.mergeCommitHash)
      ))
    : undefined;
  const deployShas = new Set(
    [headSha, merged?.mergeCommitHash]
      .filter(validCommitSha)
      .map((sha) => sha!.toLowerCase())
  );
  const deployed = Boolean(merged)
    && deployment?.state === 'ready'
    && currentDeploymentEvidence(deployment, snapshotCheckedAt)
    && sameRepository(deployment.data.repositoryFullName, repositoryFullName)
    && deployment.data.status === 'available'
    && deployment.data.environments.some((environment) => (
      environment.verification === 'healthy'
      && validCommitSha(environment.deployedSha)
      && validOptionalPastTime(environment.verifiedAt, deployment.data.checkedAt)
      && deployShas.has(environment.deployedSha!.toLowerCase())
    ));
  if (deployed) return 'deployed';
  if (merged) return 'merged';
  if (
    evidenceMatchesSession(evidence, session)
    && evidence.verification?.sessionLastActivityAt === session.lastActivityAt
    && (!evidence.verification.headSha || (
      validCommitSha(evidence.verification.headSha)
      && validCommitSha(headSha)
      && sameSha(evidence.verification.headSha, headSha)
    ))
    && validEvidenceWindow(
      session.lastActivityAt,
      evidence.verification.verifiedAt,
      snapshotCheckedAt
    )
  ) return 'verified-complete';
  return 'unknown';
}

export function resolveActivity(
  session: CodexSessionRecord,
  online: boolean,
  evidence: TopologyTaskEvidence | undefined,
  snapshotCheckedAt: string
): TopologyTaskActivity {
  if (session.archived || session.status === 'archived') return 'archived';
  if (!online || session.status === 'offline') return 'offline';
  if (
    evidenceMatchesSession(evidence, session)
    && evidence.awaitingDecision?.sessionLastActivityAt === session.lastActivityAt
    && validAwaitingDecisionWindow(
      session.lastActivityAt,
      evidence.awaitingDecision.observedAt,
      evidence.awaitingDecision.expiresAt,
      snapshotCheckedAt
    )
  ) return 'awaiting-decision';
  if (session.status === 'active') return 'active';
  if (session.status === 'idle') return 'idle-unverified';
  if (session.status === 'missing' || session.status === 'unavailable') return 'blocked';
  return 'unknown';
}

export function resolveInteraction(
  session: CodexSessionRecord,
  online: boolean,
  conversation: TopologyInventoryResult<CodexSessionReadResult>,
  locationSessionRevision: string,
  capability: TopologyTaskWriteCapability | undefined,
  snapshotCheckedAt: string
) {
  const conversationCurrent = conversation.state === 'ready'
    && sameSessionGeneration(conversation.data.session, session);
  const authority = validWriteAuthority(
    capability,
    session,
    locationSessionRevision,
    snapshotCheckedAt
  );
  const canContinue = online
    && conversationCurrent
    && authority?.canContinue === true
    && session.status === 'idle'
    && !session.archived;
  const canInterrupt = online
    && conversationCurrent
    && validTopologyRuntimeId(authority?.interruptTurnId)
    && session.status === 'active'
    && !session.archived;
  return {
    authority: canContinue || canInterrupt ? authority : undefined,
    canContinue,
    canInterrupt,
    composerVisible: canContinue || canInterrupt,
    reason: canContinue || canInterrupt
      ? undefined
      : !online
        ? 'The owning machine or Codex runtime is not reachable.'
        : !conversationCurrent
          ? 'The task transcript is not current for this exact Codex session.'
          : !authority
            ? capability?.state === 'blocked' || capability?.state === 'unavailable'
              ? capability.reason
              : 'No current existing-task write capability has been proven.'
          : session.status === 'active'
            ? 'This task is running, but no exact live turn is authorized for interruption.'
            : 'This task is not currently writable.'
  };
}

export function flattenTranscript(
  result: import('@/shared/codex-sessions-api').CodexSessionReadResult
) {
  let order = 0;
  return result.turns.flatMap((turn) => turn.items.map<TopologyTranscriptItem>((item) => ({
    ...item,
    order: order++,
    turnId: turn.id,
    turnStatus: turn.status
  })));
}

export function safeBrowser(
  _capability: TopologyBrowserCapability | undefined,
  _machineId: string,
  _threadId: string
): TopologyBrowserCapability {
  return unavailableBrowser;
}

export function validateCodexInventory(
  machineId: string,
  result: TopologyInventoryResult<CodexSessionListResult>
): TopologyInventoryResult<CodexSessionListResult> {
  if (result.state !== 'ready' && result.state !== 'stale') return result;
  const identityMismatch = result.data.machine.id !== machineId
    || result.data.sessions.some((session) => session.machineId !== machineId);
  const conflictingDuplicate = hasConflictingSessionDuplicates(result.data.sessions);
  const evidenceAt = result.state === 'ready' ? result.checkedAt : result.lastSafeAt;
  const evidenceTime = Date.parse(evidenceAt);
  const nestedTime = Date.parse(result.data.checkedAt);
  const publishedTime = Date.parse(result.data.publishedAt ?? result.data.checkedAt);
  const activityOutsideEvidence = !Number.isFinite(evidenceTime)
    || !Number.isFinite(nestedTime)
    || !Number.isFinite(publishedTime)
    || nestedTime !== evidenceTime
    || publishedTime < evidenceTime
    || result.data.sessions.some((session) => {
      const activityTime = Date.parse(session.lastActivityAt);
      return !Number.isFinite(activityTime)
        || activityTime > publishedTime + clockSkewToleranceMs;
    });
  return identityMismatch || conflictingDuplicate || activityOutsideEvidence
    ? {
        checkedAt: evidenceAt,
        reason: identityMismatch
          ? 'Codex inventory returned task identities for a different machine.'
          : conflictingDuplicate
            ? 'Codex inventory returned conflicting records for the same task identity.'
            : 'Codex inventory returned task activity outside its evidence window.',
        state: 'blocked'
      }
    : result;
}

function hasConflictingSessionDuplicates(sessions: CodexSessionRecord[]) {
  const signatures = new Map<string, string>();
  for (const session of sessions) {
    const identity = `${encodeURIComponent(session.machineId)}:${encodeURIComponent(session.id)}`;
    const signature = JSON.stringify([
      session.archived,
      session.cwd,
      session.lastActivityAt,
      session.loadedByProjectSpace,
      session.machineName,
      session.model,
      session.modelProvider,
      session.project,
      session.source,
      session.status,
      session.title
    ]);
    const previous = signatures.get(identity);
    if (previous !== undefined && previous !== signature) return true;
    signatures.set(identity, signature);
  }
  return false;
}

export function validateConversation(
  result: TopologyInventoryResult<CodexSessionReadResult>,
  session: CodexSessionRecord
): TopologyInventoryResult<CodexSessionReadResult> {
  if (result.state !== 'ready' && result.state !== 'stale') return result;
  const identityMatches = result.data.openedReadOnly === true
    && result.data.session.machineId === session.machineId
    && result.data.session.id === session.id;
  const checkedAt = result.state === 'ready' ? result.checkedAt : result.lastSafeAt;
  const evidenceTime = Date.parse(checkedAt);
  const embeddedActivityTime = Date.parse(result.data.session.lastActivityAt);
  const internallyConsistent = Number.isFinite(evidenceTime)
    && Number.isFinite(embeddedActivityTime)
    && embeddedActivityTime <= evidenceTime;
  const currentGeneration = result.state !== 'ready' || (
    sameSessionGeneration(result.data.session, session)
    && Number.isFinite(Date.parse(session.lastActivityAt))
    && evidenceTime >= Date.parse(session.lastActivityAt)
  );
  if (identityMatches && internallyConsistent && currentGeneration) return result;
  return {
    checkedAt,
    reason: identityMatches
      ? 'The Codex transcript does not cover the selected task generation.'
      : 'The Codex transcript identity does not match the selected task.',
    state: 'blocked'
  };
}

function sameSessionGeneration(left: CodexSessionRecord, right: CodexSessionRecord) {
  return left.machineId === right.machineId
    && left.id === right.id
    && left.status === right.status
    && left.archived === right.archived
    && left.lastActivityAt === right.lastActivityAt;
}

function sameBranch(left: string | undefined, right: string | undefined) {
  return Boolean(left && right && normalizeBranch(left) === normalizeBranch(right));
}

function sameSha(left: string | undefined, right: string | undefined) {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

function validCommitSha(value: string | undefined) {
  return Boolean(value && /^[0-9a-f]{40}$/i.test(value));
}

function issueNumberFromTitle(value: string) {
  const number = Number(value.match(/(?:^|\s)#(\d+)(?:\s|·|:|-|$)/)?.[1]);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function normalizeBranch(value: string) {
  return value.trim().replace(/^refs\/heads\//, '');
}

function validEvidenceWindow(sessionAt: string, observedAt: string, publishedAt: string) {
  const [sessionTime, observedTime, publicationTime] = [
    sessionAt,
    observedAt,
    publishedAt
  ].map(Date.parse);
  return [sessionTime, observedTime, publicationTime].every(Number.isFinite)
    && sessionTime! <= observedTime! + clockSkewToleranceMs
    && observedTime! <= publicationTime!;
}

function validAwaitingDecisionWindow(
  sessionLastActivityAt: string,
  observedAt: string,
  expiresAt: string,
  snapshotCheckedAt: string
) {
  const [sessionTime, observedTime, expiresTime, snapshotTime] = [
    sessionLastActivityAt,
    observedAt,
    expiresAt,
    snapshotCheckedAt
  ].map(Date.parse);
  return [sessionTime, observedTime, expiresTime, snapshotTime].every(Number.isFinite)
    && sessionTime! <= observedTime! + clockSkewToleranceMs
    && observedTime! <= snapshotTime!
    && snapshotTime! <= expiresTime!
    && expiresTime! - observedTime! <= 15 * 60 * 1000;
}

function currentDeploymentEvidence(
  deployment: Extract<TopologyInventoryResult<import('@/shared/project-space-api').DeployedEnvironmentStatusResult>, { state: 'ready' }>,
  snapshotCheckedAt: string
) {
  const envelope = Date.parse(deployment.checkedAt);
  const nested = Date.parse(deployment.data.checkedAt);
  const snapshot = Date.parse(snapshotCheckedAt);
  return [envelope, nested, snapshot].every(Number.isFinite)
    && envelope === nested
    && envelope <= snapshot
    && snapshot - envelope <= 30_000;
}

function validOptionalPastTime(value: string | undefined, observedAt: string) {
  if (value === undefined) return true;
  const valueTime = Date.parse(value);
  const observedTime = Date.parse(observedAt);
  return Number.isFinite(valueTime) && Number.isFinite(observedTime) && valueTime <= observedTime;
}

function validWriteAuthority(
  capability: TopologyTaskWriteCapability | undefined,
  session: CodexSessionRecord,
  locationSessionRevision: string,
  snapshotCheckedAt: string
) {
  if (!capability || capability.state !== 'ready') return undefined;
  const checkedAt = Date.parse(capability.checkedAt);
  const expiresAt = Date.parse(capability.expiresAt);
  return capability.machineId === session.machineId
    && capability.threadId === session.id
    && /^[0-9a-f]{64}$/.test(capability.sessionRevision)
    && capability.sessionRevision === locationSessionRevision
    && capability.sessionLastActivityAt === session.lastActivityAt
    && validEvidenceWindow(session.lastActivityAt, capability.checkedAt, snapshotCheckedAt)
    && Number.isFinite(expiresAt)
    && expiresAt >= Date.parse(snapshotCheckedAt)
    && expiresAt - checkedAt <= 5 * 60 * 1000
    ? capability
    : undefined;
}

function usableWorktree(worktree: ProjectWorktreeRecord) {
  return worktree.status === 'ready' || worktree.status === 'locked';
}

function sameRepository(left: string | undefined, right: string | undefined) {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

function evidenceMatchesSession(
  evidence: TopologyTaskEvidence | undefined,
  session: CodexSessionRecord
): evidence is TopologyTaskEvidence {
  return Boolean(
    evidence?.machineId === session.machineId && evidence.threadId === session.id
  );
}

export function connectorReachable(machine: MachineRecord | undefined) {
  return machine?.connector.status === 'local' || machine?.connector.status === 'online';
}

export function agentLabel(title: string) {
  return title.match(/^(?:#\d+\s*·\s*)?([A-Za-z][A-Za-z0-9-]*)\s*·/)?.[1] ?? 'Codex task';
}
