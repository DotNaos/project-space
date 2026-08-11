import { chmodSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import {
  ConnectorRuntimeSupervisorOutcomeReader,
  connectorRuntimeSupervisorOutcomeSchema,
  recoverConnectorRuntimeSupervisorOutcome
} from '../server/connector-runtime-supervisor-outcome';

function outcome(operationId: string) {
  return `${JSON.stringify({
    action: 'commit',
    operationId,
    schema: connectorRuntimeSupervisorOutcomeSchema
  })}\n`;
}

describe('connector runtime supervisor outcome', () => {
  test('recovers a supervisor-accepted commit after connector process death', async () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-outcome-recovery-'));
    const path = join(root, 'outcome.json');
    const environment: NodeJS.ProcessEnv = {
      PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_OPERATION_ID: 'operation-recovery',
      PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_STATE: 'pending-health-check',
      PROJECT_CONNECTOR_RUNTIME_OUTCOME_FILE: path,
      PROJECT_SPACE_INSTALL_SOURCE: 'managed'
    };
    writeFileSync(path, outcome('operation-recovery'), { mode: 0o600 });
    const committed: string[] = [];
    try {
      expect(await recoverConnectorRuntimeSupervisorOutcome({
        async commit(operationId) { committed.push(operationId); },
        environment
      })).toBe(true);
      expect(committed).toEqual(['operation-recovery']);
      expect(existsSync(path)).toBe(false);
      expect(environment.PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_OPERATION_ID).toBeUndefined();
      expect(environment.PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_STATE).toBeUndefined();

      expect(await recoverConnectorRuntimeSupervisorOutcome({
        async commit(operationId) { committed.push(operationId); },
        environment
      })).toBe(false);
      expect(committed).toEqual(['operation-recovery']);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test('keeps the outcome durable when the Codex commit fails for restart retry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-outcome-retry-'));
    const path = join(root, 'outcome.json');
    const environment: NodeJS.ProcessEnv = {
      PROJECT_CONNECTOR_RUNTIME_OUTCOME_FILE: path,
      PROJECT_SPACE_INSTALL_SOURCE: 'managed'
    };
    writeFileSync(path, outcome('operation-retry'), { mode: 0o600 });
    try {
      await expect(recoverConnectorRuntimeSupervisorOutcome({
        async commit() { throw new Error('simulated pointer failure'); },
        environment
      })).rejects.toThrow('simulated pointer failure');
      expect(existsSync(path)).toBe(true);

      expect(await recoverConnectorRuntimeSupervisorOutcome({
        async commit(operationId) { expect(operationId).toBe('operation-retry'); },
        environment
      })).toBe(true);
      expect(existsSync(path)).toBe(false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test('rejects non-canonical, permissive, and indirect outcome files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-outcome-security-'));
    const path = join(root, 'outcome.json');
    const reader = new ConnectorRuntimeSupervisorOutcomeReader(path);
    try {
      writeFileSync(path, ` ${outcome('operation-invalid')}`, { mode: 0o600 });
      await expect(reader.read()).rejects.toThrow('outcome is invalid');

      writeFileSync(path, outcome('operation-invalid'), { mode: 0o644 });
      chmodSync(path, 0o644);
      await expect(reader.read()).rejects.toThrow('outcome file is unsafe');

      rmSync(path);
      const target = join(root, 'real-outcome.json');
      writeFileSync(target, outcome('operation-invalid'), { mode: 0o600 });
      symlinkSync(target, path);
      await expect(reader.read()).rejects.toThrow('outcome file is unsafe');
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
