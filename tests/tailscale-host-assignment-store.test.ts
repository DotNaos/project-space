import { describe, expect, test } from 'bun:test';
import type { DatabaseQueryClient } from '../server/database/client';
import {
  PostgresTailscaleInventoryStore,
  TailscaleHostAssignmentRevisionConflict,
  UnknownTailscaleHost
} from '../server/tailscale-inventory/store';

interface Assignment { hostId?: string; revision: number }

class HostAssignmentDatabase implements DatabaseQueryClient {
  readonly audits: Array<{ nextHostId?: string; previousHostId?: string; revision: number }> = [];
  readonly hosts = new Map<string, string>();
  readonly observations = new Set<string>();
  private readonly assignments = new Map<string, Assignment>();

  seedDevice(owner: string, deviceId: string) {
    this.observations.add(`${owner}:${deviceId}`);
  }

  seedHost(owner: string, hostId: string, name = 'Host') {
    this.hosts.set(`${owner}:${hostId}`, name);
  }

  async query<Row>(sql: string, values: readonly unknown[] = []) {
    if (sql.includes('select device_id from tailscale_device_observations')) {
      const key = `${values[0]}:${values[1]}`;
      return { rows: this.observations.has(key) ? [{ device_id: values[1] } as Row] : [] };
    }
    if (sql.includes('select host_id, revision from tailscale_device_host_assignments')) {
      const current = this.assignments.get(this.assignmentKey(values));
      return { rows: current ? [{ host_id: current.hostId ?? null, revision: current.revision } as Row] : [] };
    }
    if (sql.includes('insert into compute_platforms')) {
      return { rows: [{ id: `platform-${values[1]}` } as Row] };
    }
    if (sql.includes('insert into physical_machines')) {
      this.seedHost(String(values[1]), String(values[0]), String(values[2]));
      return { rows: [{ id: values[0] } as Row] };
    }
    if (sql.includes('insert into compute_hosts')) return { rows: [] as Row[] };
    if (sql.includes('select id from physical_machines')) {
      const key = `${values[0]}:${values[1]}`;
      return { rows: this.hosts.has(key) ? [{ id: values[1] } as Row] : [] };
    }
    if (sql.includes('insert into tailscale_device_host_assignments')) {
      const key = this.assignmentKey(values);
      const current = this.assignments.get(key);
      const expectedRevision = Number(values[5]);
      if ((current?.revision ?? 0) !== expectedRevision) return { rows: [] as Row[] };
      const next = {
        ...(values[3] ? { hostId: String(values[3]) } : {}),
        revision: expectedRevision + 1
      };
      this.assignments.set(key, next);
      return { rows: [{ host_id: next.hostId ?? null, revision: next.revision } as Row] };
    }
    if (sql.includes('insert into tailscale_device_host_assignment_audits')) {
      this.audits.push({
        ...(values[4] ? { previousHostId: String(values[4]) } : {}),
        ...(values[5] ? { nextHostId: String(values[5]) } : {}),
        revision: Number(values[6])
      });
      return { rows: [] as Row[] };
    }
    throw new Error(`Unexpected Host assignment query: ${sql}`);
  }

  async transaction<Result>(operation: (client: DatabaseQueryClient) => Promise<Result>) {
    const assignments = new Map(this.assignments);
    const hosts = new Map(this.hosts);
    const audits = [...this.audits];
    try {
      return await operation(this);
    } catch (error) {
      this.assignments.clear();
      assignments.forEach((value, key) => this.assignments.set(key, value));
      this.hosts.clear();
      hosts.forEach((value, key) => this.hosts.set(key, value));
      this.audits.splice(0, this.audits.length, ...audits);
      throw error;
    }
  }

  private assignmentKey(values: readonly unknown[]) {
    return `${values[0]}:${values[1]}:${values[2]}`;
  }
}

const deviceOwner = 'project-space:tailscale-deployment';
const owner = 'user-a';
const deviceId = 'device-a';

function input(request: Parameters<PostgresTailscaleInventoryStore['setHostAssignment']>[0]['request']) {
  return { actorId: owner, deviceId, deviceOwnerUserId: deviceOwner, ownerUserId: owner, request };
}

describe('Tailnet device Host assignment store', () => {
  test('creates, moves, and removes one durable manual Host assignment', async () => {
    const database = new HostAssignmentDatabase();
    database.seedDevice(deviceOwner, deviceId);
    const store = new PostgresTailscaleInventoryStore(database);

    const created = await store.setHostAssignment(input({
      action: 'create', expectedRevision: 0, name: 'MacBook'
    }));
    expect(created).toMatchObject({ deviceId, hostId: expect.any(String), revision: 1 });
    expect([...database.hosts.values()]).toContain('MacBook');

    const destination = '24000000-0000-4000-8000-000000000002';
    database.seedHost(owner, destination, 'Server');
    await expect(store.setHostAssignment(input({
      action: 'assign', expectedRevision: 1, hostId: destination
    }))).resolves.toEqual({ deviceId, hostId: destination, revision: 2 });

    await expect(store.setHostAssignment(input({
      action: 'unassign', expectedRevision: 2
    }))).resolves.toEqual({ deviceId, revision: 3 });
    expect(database.audits).toEqual([
      { nextHostId: created.hostId, revision: 1 },
      { nextHostId: destination, previousHostId: created.hostId, revision: 2 },
      { previousHostId: destination, revision: 3 }
    ]);
  });

  test('fails closed for stale revisions and Hosts owned by another account', async () => {
    const database = new HostAssignmentDatabase();
    database.seedDevice(deviceOwner, deviceId);
    const store = new PostgresTailscaleInventoryStore(database);
    const created = await store.setHostAssignment(input({
      action: 'create', expectedRevision: 0, name: 'MacBook'
    }));

    await expect(store.setHostAssignment(input({
      action: 'unassign', expectedRevision: 0
    }))).rejects.toBeInstanceOf(TailscaleHostAssignmentRevisionConflict);
    expect(database.audits).toHaveLength(1);

    const foreignHost = '24000000-0000-4000-8000-000000000003';
    database.seedHost('user-b', foreignHost);
    await expect(store.setHostAssignment(input({
      action: 'assign', expectedRevision: created.revision, hostId: foreignHost
    }))).rejects.toBeInstanceOf(UnknownTailscaleHost);
  });
});
