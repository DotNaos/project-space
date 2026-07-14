import {
  topologyTaskId,
  type TopologyMachine,
  type TopologyProject,
  type TopologyTask
} from './project-topology-types';
import { validTopologyRuntimeId } from './project-topology-runtime-id';

export interface TopologyTaskOrigin {
  machineId: string;
  threadId: string;
}

export interface ExistingCodexTaskController<TResult = unknown> {
  continue(origin: TopologyTaskOrigin, message: string): Promise<TResult>;
  interrupt(origin: TopologyTaskOrigin, turnId: string): Promise<TResult>;
  select(origin: TopologyTaskOrigin): Promise<void>;
}

export type TopologyCoordinatorTarget =
  | { kind: 'lead' }
  | { chatProjectId: string; kind: 'project-lead'; projectId: string };

export interface ProjectTopologyNavigationActions {
  openCoordinator(target: TopologyCoordinatorTarget): void;
  openIssue(projectId: string, issueNumber: number): void;
  resetFocus(): void;
}

export class TopologyTaskActionError extends Error {
  constructor(
    readonly code: 'identity-mismatch' | 'interrupt-blocked' | 'message-empty' | 'write-blocked',
    message: string
  ) {
    super(message);
    this.name = 'TopologyTaskActionError';
  }
}

export class TopologyExistingTaskActions<TResult = unknown> {
  private readonly pendingTaskIds = new Set<string>();

  constructor(
    private readonly controller: ExistingCodexTaskController<TResult>,
    private readonly now: () => Date = () => new Date()
  ) {}

  select(task: TopologyTask) {
    return this.controller.select(topologyTaskOrigin(task));
  }

  continue(task: TopologyTask, message: string) {
    const origin = topologyTaskOrigin(task);
    if (!task.interaction.canContinue || !task.interaction.composerVisible) {
      throw new TopologyTaskActionError(
        'write-blocked',
        task.interaction.reason ?? 'This existing Codex task is not writable.'
      );
    }
    const cleanMessage = message.trim();
    if (!cleanMessage) {
      throw new TopologyTaskActionError('message-empty', 'Enter a message first.');
    }
    const authority = this.requireCurrentAuthority(task, 'continue');
    if (!authority.canContinue) {
      throw new TopologyTaskActionError(
        'write-blocked',
        'The current capability does not authorize a follow-up.'
      );
    }
    return this.dispatchOnce(task, () => this.controller.continue(origin, cleanMessage));
  }

  interrupt(task: TopologyTask) {
    const origin = topologyTaskOrigin(task);
    if (!task.interaction.canInterrupt) {
      throw new TopologyTaskActionError(
        'interrupt-blocked',
        task.interaction.reason ?? 'This Codex turn cannot be interrupted safely.'
      );
    }
    const authority = this.requireCurrentAuthority(task, 'interrupt');
    const turnId = authority.interruptTurnId;
    if (!validTopologyRuntimeId(turnId)) {
      throw new TopologyTaskActionError(
        'interrupt-blocked',
        'No exact live turn is authorized for interruption.'
      );
    }
    return this.dispatchOnce(task, () => this.controller.interrupt(origin, turnId));
  }

  private dispatchOnce(task: TopologyTask, dispatch: () => Promise<TResult>) {
    if (this.pendingTaskIds.has(task.id)) {
      throw new TopologyTaskActionError(
        'write-blocked',
        'A write operation is already pending for this Codex task.'
      );
    }
    this.pendingTaskIds.add(task.id);
    try {
      return dispatch().finally(() => this.pendingTaskIds.delete(task.id));
    } catch (error) {
      this.pendingTaskIds.delete(task.id);
      throw error;
    }
  }

  private requireCurrentAuthority(task: TopologyTask, action: 'continue' | 'interrupt') {
    const authority = task.interaction.authority;
    const code = action === 'interrupt' ? 'interrupt-blocked' : 'write-blocked';
    const now = this.now().getTime();
    const sessionLastActivityAt = Date.parse(task.session.lastActivityAt);
    const checkedAt = authority ? Date.parse(authority.checkedAt) : Number.NaN;
    const expiresAt = authority ? Date.parse(authority.expiresAt) : Number.NaN;
    if (
      !authority
      || authority.machineId !== task.machineId
      || authority.threadId !== task.threadId
      || !/^[0-9a-f]{64}$/.test(authority.sessionRevision)
      || authority.sessionRevision !== task.evidence.sessionRevision
      || authority.sessionLastActivityAt !== task.session.lastActivityAt
      || !Number.isFinite(now)
      || !Number.isFinite(sessionLastActivityAt)
      || !Number.isFinite(checkedAt)
      || !Number.isFinite(expiresAt)
      || sessionLastActivityAt > checkedAt + 30_000
      || checkedAt > now
      || expiresAt <= now
      || expiresAt - checkedAt > 5 * 60 * 1_000
    ) {
      throw new TopologyTaskActionError(
        code,
        'The existing-task authority is missing, expired, or no longer matches this task.'
      );
    }
    return authority;
  }
}

export function topologyTaskOrigin(task: TopologyTask) {
  if (
    task.id !== topologyTaskId(task.machineId, task.threadId)
    || task.machineId !== task.session.machineId
    || task.threadId !== task.session.id
  ) {
    throw new TopologyTaskActionError(
      'identity-mismatch',
      'The selected topology task does not have one consistent Codex identity.'
    );
  }
  return { machineId: task.machineId, threadId: task.threadId };
}

export function topologyProjectLeadTarget(
  project: Pick<TopologyProject, 'chatProjectId' | 'id'>
): TopologyCoordinatorTarget {
  return { chatProjectId: project.chatProjectId, kind: 'project-lead', projectId: project.id };
}

export function topologyIssueNavigationProjectId(
  project: Pick<TopologyProject, 'machines'>,
  focusedMachine?: Pick<TopologyMachine, 'projectRecords'>
) {
  const machine = focusedMachine
    ?? (project.machines.length === 1
      ? project.machines[0]
      : project.machines.find((candidate) => candidate.occupancy === 'primary'));
  if (!machine) return undefined;
  const projectIds = [...new Set(machine.projectRecords.map((record) => record.id))];
  return projectIds.length === 1 ? projectIds[0] : undefined;
}
