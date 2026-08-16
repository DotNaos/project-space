import { describe, expect, test } from 'bun:test';
import { createCodexHostInventoryService } from '../server/codex-host-inventory';
import type { DatabaseQueryClient } from '../server/database/client';

class HostInventoryClient implements DatabaseQueryClient {
  readonly calls: Array<{ sql: string; values: readonly unknown[] }> = [];

  async query<Row>(sql: string, values: readonly unknown[] = []) {
    this.calls.push({ sql, values });
    return {
      rows: [{
        addresses: ['100.80.135.9', 'fd7a:115c:a1e0::1'],
        device_id: 'device-online',
        machine_id: 'machine-online',
        machine_name: 'os-macbook',
        worktrees: [
          { path: '/Users/oli/projects/project-space', threadCount: 12 },
          { path: '/Users/oli/projects/.worktrees/project-space/issue-479', threadCount: 3 }
        ]
      }] as Row[]
    };
  }
}

describe('Codex host inventory', () => {
  test('projects exact addresses and real worktree counts for the signed-in owner', async () => {
    const client = new HostInventoryClient();
    const service = createCodexHostInventoryService(
      client,
      () => new Date('2026-08-16T16:00:00.000Z')
    );

    const result = await service.list('owner-user');

    expect(result).toEqual({
      apiVersion: 1,
      checkedAt: '2026-08-16T16:00:00.000Z',
      hosts: [{
        addresses: ['100.80.135.9', 'fd7a:115c:a1e0::1'],
        machineId: 'machine-online',
        name: 'os-macbook',
        tailscaleDeviceId: 'device-online',
        worktrees: [
          { label: 'project-space', path: '/Users/oli/projects/project-space', threadCount: 12 },
          { label: 'issue-479', path: '/Users/oli/projects/.worktrees/project-space/issue-479', threadCount: 3 }
        ]
      }]
    });
    expect(client.calls[0]?.values).toEqual([
      'owner-user',
      'project-space:tailscale-deployment'
    ]);
  });

  test('requires fresh current online Tailscale evidence without a DNS readiness dependency', async () => {
    const client = new HostInventoryClient();
    await createCodexHostInventoryService(client).list('owner-user');
    const sql = client.calls[0]?.sql ?? '';

    expect(sql).toContain('observation.online = true');
    expect(sql).toContain("observation.inventory_state = 'current'");
    expect(sql).toContain('observation.fresh_until > now()');
    expect(sql).toContain('observation.addresses');
    expect(sql).toContain("snapshot.snapshot ->> 'archived'");
    expect(sql).not.toContain('MagicDNS');
  });
});
