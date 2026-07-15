import { describe, expect, test } from 'bun:test';

import { ConnectorMachineSnapshotStore } from '../server/connector-machine-snapshot-store';
import type { DatabaseQueryClient } from '../server/database/client';
import type { ConnectorProjectRegistryResult } from '../src/shared/project-space-api';

function registry(machineId: string, projectId: string): ConnectorProjectRegistryResult {
  return {
    checkedAt: '2026-07-11T00:00:00.000Z',
    connector: { machineId, machineName: `Name ${machineId}` },
    discovery: {
      groups: [],
      projects: [
        {
          id: projectId,
          kind: 'standalone',
          name: projectId,
          rootPath: `/${projectId}`
        }
      ],
      rootItems: [{ id: projectId, kind: 'project', label: projectId, projectId }],
      rootPath: '/',
      structureViolations: []
    }
  };
}

class SnapshotClient implements DatabaseQueryClient {
  readonly calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  row: {
    connector_channel: string | null;
    connector_source: string | null;
    first_seen_at: string;
    last_seen_at: string;
    registry: ConnectorProjectRegistryResult;
    removed_at?: string;
    removed_by_user_id?: string;
  } | null = null;
  readonly owners = new Map<string, string>([['macbook', 'user-1']]);

  async query<Row>(sql: string, values: readonly unknown[] = []) {
    this.calls.push({ sql, values });
    if (sql.includes('insert into connector_machine_snapshots')) {
      const receivedAt = String(values[3]);
      if (
        !this.row ||
        (!this.row.removed_at && Date.parse(this.row.last_seen_at) <= Date.parse(receivedAt))
      ) {
        this.row = {
          connector_channel: values[4] as string | null,
          connector_source: values[5] as string | null,
          first_seen_at: this.row?.first_seen_at ?? receivedAt,
          last_seen_at: receivedAt,
          registry: structuredClone(values[2] as ConnectorProjectRegistryResult)
        };
      }
      return { rows: [] as Row[], rowCount: 1 };
    }
    if (sql.includes('select registry')) {
      return {
        rows: (this.row && !this.row.removed_at ? [structuredClone(this.row)] : []) as Row[],
        rowCount: this.row && !this.row.removed_at ? 1 : 0
      };
    }
    if (sql.includes('update connector_machine_snapshots')) {
      const machineId = String(values[0]);
      const userId = String(values[1]);
      const removed = Boolean(
        this.row && !this.row.removed_at && this.owners.get(machineId) === userId
      );
      if (removed && this.row) {
        this.row.removed_at = String(values[2]);
        this.row.removed_by_user_id = userId;
      }
      return {
        rows: (removed ? [{ machine_id: values[0] }] : []) as Row[],
        rowCount: removed ? 1 : 0
      };
    }
    return { rows: [] as Row[], rowCount: 0 };
  }
}

describe('ConnectorMachineSnapshotStore', () => {
  test('reconstructs the last discovery snapshot after a store instance restart', async () => {
    const client = new SnapshotClient();
    const first = new ConnectorMachineSnapshotStore(client);
    await first.upsert(registry('macbook', 'project-one'), '2026-07-11T00:00:00.000Z');

    const restarted = new ConnectorMachineSnapshotStore(client);
    expect(await restarted.list()).toEqual([
      {
        firstSeenAt: '2026-07-11T00:00:00.000Z',
        lastSeenAt: '2026-07-11T00:00:00.000Z',
        registry: registry('macbook', 'project-one')
      }
    ]);
  });

  test('persists only the server-bound connector profile beside the registry', async () => {
    const client = new SnapshotClient();
    const store = new ConnectorMachineSnapshotStore(client);
    await store.upsert(
      registry('macbook', 'project-one'),
      '2026-07-11T00:00:00.000Z',
      { channel: 'dev', source: 'source' }
    );

    expect((await store.list())[0]?.connectorProfile).toEqual({
      channel: 'dev',
      source: 'source'
    });
    expect(client.calls[0]?.values.slice(4)).toEqual(['dev', 'source']);
  });

  test('keeps first-seen identity, updates the snapshot, and rejects an older write', async () => {
    const client = new SnapshotClient();
    const store = new ConnectorMachineSnapshotStore(client);
    await store.upsert(registry('macbook', 'old'), '2026-07-11T00:00:00.000Z');
    await store.upsert(registry('macbook', 'new'), '2026-07-11T00:05:00.000Z');
    await store.upsert(registry('macbook', 'stale'), '2026-07-11T00:01:00.000Z');

    const [snapshot] = await store.list();
    expect(snapshot.firstSeenAt).toBe('2026-07-11T00:00:00.000Z');
    expect(snapshot.lastSeenAt).toBe('2026-07-11T00:05:00.000Z');
    expect(snapshot.registry.discovery.projects[0]?.id).toBe('new');
    expect(client.calls[0]?.sql).toContain(
      'connector_machine_snapshots.last_seen_at <= excluded.last_seen_at'
    );
  });

  test('requires an explicit approving user and records removal without deleting', async () => {
    const client = new SnapshotClient();
    const store = new ConnectorMachineSnapshotStore(client);
    await store.upsert(registry('macbook', 'project'), '2026-07-11T00:00:00.000Z');

    await expect(store.removeApproved('macbook', '', '2026-07-11T00:10:00.000Z')).rejects.toThrow(
      'approving user'
    );
    expect(await store.removeApproved('macbook', 'not-owner', '2026-07-11T00:10:00.000Z')).toBe(false);
    expect(await store.removeApproved('macbook', 'user-1', '2026-07-11T00:10:00.000Z')).toBe(true);
    const removal = client.calls.find(
      (call) =>
        call.sql.includes('update connector_machine_snapshots') && call.values[1] === 'user-1'
    );
    expect(removal?.sql).not.toContain('delete from');
    expect(removal?.sql).toContain("role = 'owner'");
    expect(removal?.values).toEqual(['macbook', 'user-1', '2026-07-11T00:10:00.000Z']);
    expect(await store.list()).toEqual([]);

    await store.upsert(registry('macbook', 'resurrection'), '2026-07-11T00:20:00.000Z');
    expect(await store.list()).toEqual([]);
    expect(client.row?.removed_by_user_id).toBe('user-1');
  });
});
