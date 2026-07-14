import { describe, expect, test } from 'bun:test';

import {
  codexSessionInspectionMatchesScope,
  codexSessionRevision,
  withCodexSessionWriteCapability
} from '../server/codex-sessions/task-access-evidence';
import type {
  CodexSessionInspectResult,
  CodexSessionRecord
} from '../src/shared/codex-sessions-api';

const session: CodexSessionRecord = {
  archived: false,
  cwd: '/projects/project-space',
  id: '019f5a78-3c4c-7082-bb45-5411be7d9b9a',
  lastActivityAt: '2026-07-14T08:00:00.000Z',
  loadedByProjectSpace: true,
  machineId: 'codex-channel-machine',
  machineName: 'Test machine',
  status: 'idle',
  title: 'Implement topology command center'
};

const taskLocation = {
  canonicalCwd: '/projects/project-space',
  worktreeRoot: '/projects/project-space'
};

describe('Codex task access evidence', () => {
  test('invalidates the opaque session revision across connector and runtime restarts', () => {
    const current = codexSessionRevision({
      connectorGeneration: 7,
      runtimeEpoch: 3,
      session,
      taskLocation
    });
    const reconnected = codexSessionRevision({
      connectorGeneration: 8,
      runtimeEpoch: 3,
      session,
      taskLocation
    });
    const restarted = codexSessionRevision({
      connectorGeneration: 7,
      runtimeEpoch: 4,
      session,
      taskLocation
    });

    expect(current).toMatch(/^[0-9a-f]{64}$/);
    expect(reconnected).toMatch(/^[0-9a-f]{64}$/);
    expect(restarted).toMatch(/^[0-9a-f]{64}$/);
    expect(reconnected).not.toBe(current);
    expect(restarted).not.toBe(current);
    expect(restarted).not.toBe(reconnected);
  });

  test('validates Windows connector paths independently of the server operating system', () => {
    const checkedAt = '2026-07-14T08:00:01.000Z';
    const sessionRevision = 'a'.repeat(64);
    const result: CodexSessionInspectResult = {
      checkedAt,
      openedReadOnly: true,
      session: {
        ...session,
        cwd: 'C:\\Projects\\Project-Space\\src',
        machineId: 'windows-machine'
      },
      sessionRevision,
      taskLocation: {
        canonicalCwd: 'c:\\projects\\project-space\\src',
        checkedAt,
        machineId: 'windows-machine',
        sessionRevision,
        source: 'connector-realpath',
        threadId: session.id,
        worktreeRoot: 'C:\\Projects\\Project-Space'
      }
    };

    expect(codexSessionInspectionMatchesScope(result, {
      machineId: 'windows-machine',
      threadId: session.id
    })).toBe(true);
  });

  test('never mints interruption authority without an exact active turn', () => {
    const checkedAt = new Date('2026-07-14T08:00:01.000Z');
    const sessionRevision = 'b'.repeat(64);
    const result: CodexSessionInspectResult = {
      checkedAt: checkedAt.toISOString(),
      openedReadOnly: true,
      session: { ...session, status: 'active' },
      sessionRevision,
      taskLocation: {
        ...taskLocation,
        checkedAt: checkedAt.toISOString(),
        machineId: session.machineId,
        sessionRevision,
        source: 'connector-realpath',
        threadId: session.id
      }
    };

    expect(withCodexSessionWriteCapability(result, checkedAt).writeCapability).toMatchObject({
      reason: 'The active Codex turn identity could not be verified.',
      state: 'unavailable'
    });
  });
});
