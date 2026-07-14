import type { CodexSessionReadResult } from '@/shared/codex-sessions-api';
import {
  validateProjectTopologySourceResult,
  withoutTopologyWriteCapabilities,
  type ProjectTopologySource
} from './project-topology-loader';
import { buildProjectTopology } from './project-topology-model';
import { revalidateTopologyPublication } from './project-topology-publication';
import type {
  ProjectTopologyInventory,
  TopologyInventoryResult,
  TopologyTask,
  TopologyTaskWriteCapability
} from './project-topology-types';

export interface ProjectTopologySelectedTaskLoadOptions {
  clock?: () => string;
  signal?: AbortSignal;
}

export async function loadProjectTopologySelectedTask(
  source: ProjectTopologySource,
  inventory: ProjectTopologyInventory,
  taskId: string,
  options: ProjectTopologySelectedTaskLoadOptions = {}
): Promise<ProjectTopologyInventory> {
  const clock = options.clock ?? (() => new Date().toISOString());
  const readOnlyInventory = withoutTopologyWriteCapabilities(inventory);
  const task = findCurrentTopologyTask(readOnlyInventory, taskId);
  if (!task) return readOnlyInventory;

  const conversationAttempt = await capture(() => source.readCodexSession(
    task.machineId,
    task.threadId,
    options.signal
  ));
  const readAt = clock();
  const conversation = conversationAttempt.ok
    ? validateProjectTopologySourceResult(conversationAttempt.value, readAt)
    : blockedConversation(conversationAttempt.error, readAt);
  const conversationMatches = conversation.state === 'ready'
    && sameSelectedSession(task, conversation.data);
  const capabilityAttempt = conversationMatches && source.getCodexSessionWriteCapability
    ? await capture(() => source.getCodexSessionWriteCapability!(
        task.machineId,
        task.threadId,
        options.signal
      ))
    : undefined;
  const publishedAt = clock();
  const capability = capabilityAttempt
    ? capabilityAttempt.ok
      ? capabilityAttempt.value
      : blockedCapability(capabilityAttempt.error, publishedAt)
    : undefined;

  return revalidateTopologyPublication({
    ...readOnlyInventory,
    checkedAt: publishedAt,
    conversationsByTaskId: {
      ...readOnlyInventory.conversationsByTaskId,
      [task.id]: conversation
    },
    ...(capability ? { writeCapabilitiesByTaskId: { [task.id]: capability } } : {})
  });
}

function sameSelectedSession(
  task: TopologyTask,
  conversation: CodexSessionReadResult
) {
  const session = conversation.session;
  return conversation.openedReadOnly === true
    && session.machineId === task.machineId
    && session.id === task.threadId
    && session.lastActivityAt === task.session.lastActivityAt
    && session.status === task.session.status
    && session.archived === task.session.archived;
}

export function topologyInventoryHasCurrentTask(
  inventory: ProjectTopologyInventory,
  taskId: string
) {
  return Boolean(findCurrentTopologyTask(inventory, taskId));
}

function findCurrentTopologyTask(
  inventory: ProjectTopologyInventory,
  taskId: string
): TopologyTask | undefined {
  const build = buildProjectTopology(inventory);
  if (build.state !== 'ready') return undefined;
  if (
    build.snapshot.inventory.projects.state !== 'ready'
    || build.snapshot.inventory.machines.state !== 'ready'
  ) return undefined;
  for (const project of build.snapshot.projects) {
    for (const machine of project.machines) {
      const task = machine.tasks.find((candidate) => candidate.id === taskId);
      if (!task) continue;
      const activityCanWrite = task.activity === 'active'
        || task.activity === 'awaiting-decision'
        || task.activity === 'idle-unverified';
      const sessionCanWrite = task.session.status === 'active'
        || task.session.status === 'idle';
      return task.evidence.current
        && project.inventory.state === 'ready'
        && machine.inventory.state === 'ready'
        && machine.taskInventory.state === 'ready'
        && activityCanWrite
        && sessionCanWrite
        && !task.session.archived
          ? task
          : undefined;
    }
  }
  return undefined;
}

function blockedConversation(
  error: unknown,
  checkedAt: string
): TopologyInventoryResult<CodexSessionReadResult> {
  return { checkedAt, reason: errorMessage(error), state: 'blocked' };
}

function blockedCapability(
  error: unknown,
  checkedAt: string
): TopologyTaskWriteCapability {
  return { checkedAt, reason: errorMessage(error), state: 'blocked' };
}

function errorMessage(error: unknown) {
  return error instanceof Error && error.message.trim()
    ? error.message.trim()
    : 'The selected Codex task could not be verified.';
}

async function capture<T>(load: () => Promise<T>) {
  try {
    return { ok: true as const, value: await load() };
  } catch (error) {
    return { error, ok: false as const };
  }
}
