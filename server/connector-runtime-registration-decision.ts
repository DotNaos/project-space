import { randomBytes } from 'node:crypto';
import { link, open, rm, unlink } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';

import type { ConnectorRuntimeMaintenanceEvidence } from '../src/shared/connector-runtime-api';
import type { ConnectorProjectRegistryResult } from '../src/shared/project-space-api';

export const connectorRuntimeSupervisorDecisionSchema =
  'project-space.connector-runtime-supervisor-decision/v1' as const;

export interface ConnectorRuntimeMaintenanceDecision {
  action: 'commit' | 'rollback';
  operationId: string;
}

export interface ConnectorRuntimeSupervisorDecision
  extends ConnectorRuntimeMaintenanceDecision {
  schema: typeof connectorRuntimeSupervisorDecisionSchema;
}

const operationIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

export function isConnectorRuntimeMaintenanceEvidence(
  value: unknown
): value is ConnectorRuntimeMaintenanceEvidence {
  return isRecord(value) && hasExactKeys(value, ['operationId', 'state']) &&
    typeof value.operationId === 'string' && operationIdPattern.test(value.operationId) &&
    (value.state === 'pending-health-check' || value.state === 'rolled-back');
}

export function isConnectorRuntimeMaintenanceDecision(
  value: unknown
): value is ConnectorRuntimeMaintenanceDecision {
  return isRecord(value) && hasExactKeys(value, ['action', 'operationId']) &&
    (value.action === 'commit' || value.action === 'rollback') &&
    typeof value.operationId === 'string' && operationIdPattern.test(value.operationId);
}

export function isConnectorRuntimeSupervisorDecision(
  value: unknown
): value is ConnectorRuntimeSupervisorDecision {
  return isRecord(value) && hasExactKeys(value, ['action', 'operationId', 'schema']) &&
    value.schema === connectorRuntimeSupervisorDecisionSchema &&
    isConnectorRuntimeMaintenanceDecision({
      action: value.action,
      operationId: value.operationId
    });
}

export function connectorRuntimeMaintenanceEvidence(
  registry: ConnectorProjectRegistryResult
) {
  const evidence = registry.connector.runtime?.maintenance;
  return isConnectorRuntimeMaintenanceEvidence(evidence) ? evidence : undefined;
}

export function connectorRuntimeDecisionMatchesEvidence(
  evidence: ConnectorRuntimeMaintenanceEvidence | undefined,
  decision: ConnectorRuntimeMaintenanceDecision | undefined
) {
  if (!evidence || !decision || evidence.operationId !== decision.operationId) return false;
  return evidence.state !== 'rolled-back' || decision.action === 'rollback';
}

async function publishExclusive(path: string, body: string) {
  const temporary = `${path}.${randomBytes(12).toString('hex')}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(body, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporary, path);
    await unlink(temporary);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export class ConnectorRuntimeDecisionWriter {
  constructor(private readonly decisionFilePath: string) {
    if (!isAbsolute(decisionFilePath) || basename(decisionFilePath) !== 'decision.json') {
      throw new Error('The connector runtime decision path is invalid.');
    }
  }

  async accept(
    evidence: ConnectorRuntimeMaintenanceEvidence | undefined,
    decision: ConnectorRuntimeMaintenanceDecision | undefined
  ) {
    if (!evidence && !decision) return;
    if (!connectorRuntimeDecisionMatchesEvidence(evidence, decision)) {
      throw new Error('The connector runtime decision does not match registration evidence.');
    }
    const document: ConnectorRuntimeSupervisorDecision = {
      ...decision!,
      schema: connectorRuntimeSupervisorDecisionSchema
    };
    await publishExclusive(this.decisionFilePath, `${JSON.stringify(document)}\n`);
  }
}
