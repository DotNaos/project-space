import { createHash } from 'node:crypto';

import { canonicalJson } from '../codex-sessions/canonical-json';
import type { TaskDeliveryProviderTarget, TaskDeliveryRecord } from './contracts';
import type {
  TaskDeliveryActor,
  TaskDeliveryServiceDependencies
} from './service-contracts';
import { TaskDeliveryTargetUnavailableError } from './service-contracts';

export interface LoadedTaskDeliveryContext {
  delivery?: TaskDeliveryRecord;
  execution: Awaited<ReturnType<TaskDeliveryServiceDependencies['taskExecutions']['get']>>['execution'];
  objective: string;
  target: TaskDeliveryProviderTarget;
}

export async function loadTaskDeliveryContext(
  dependencies: TaskDeliveryServiceDependencies,
  actor: TaskDeliveryActor,
  executionId: string,
  permission: 'read' | 'repository_write' | 'task_write'
): Promise<LoadedTaskDeliveryContext> {
  try {
    const result = await dependencies.taskExecutions.get(actor, { executionId, limit: 1 });
    const handoff = await dependencies.taskExecutions.getHandoff(actor, {
      handoffId: result.execution.handoff.id,
      revision: result.execution.handoff.revision
    });
    const requested = handoff.handoff.requestedPermissions;
    if (permission === 'repository_write' && (
      requested.delivery !== 'pull_request' || requested.repository !== 'write'
    )) throw new TaskDeliveryTargetUnavailableError();
    if (permission === 'task_write' && requested.task !== 'write') {
      throw new TaskDeliveryTargetUnavailableError();
    }
    const target: TaskDeliveryProviderTarget = {
      branch: result.execution.source.branch,
      providerKind: result.execution.source.provider,
      repositoryId: result.execution.source.repositoryId,
      taskId: result.execution.source.taskId
    };
    return {
      delivery: await dependencies.store.readByTarget(actor.userId, target),
      execution: result.execution,
      objective: handoff.handoff.objective,
      target
    };
  } catch (error) {
    if (error instanceof TaskDeliveryTargetUnavailableError) throw error;
    throw new TaskDeliveryTargetUnavailableError();
  }
}

export function taskDeliveryFingerprint(value: unknown) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function encodeTaskDeliveryCursor(value: { createdAt: string; id: string }) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeTaskDeliveryCursor(value: string | undefined) {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
      createdAt?: unknown;
      id?: unknown;
    };
    if (typeof parsed.createdAt !== 'string' || !Number.isFinite(Date.parse(parsed.createdAt)) ||
        typeof parsed.id !== 'string' || !uuid.test(parsed.id)) {
      throw new Error('invalid cursor');
    }
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw new TaskDeliveryTargetUnavailableError();
  }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
