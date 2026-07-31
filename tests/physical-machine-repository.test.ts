import { describe, expect, test } from 'bun:test';

import type { DatabaseQueryClient } from '../server/database/client';
import { ProjectSpaceDatabaseRepository } from '../server/database/repository';

class PhysicalMachineClient implements DatabaseQueryClient {
  readonly calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  deleteAllowed = true;
  ownedConnectorIds = ['windows', 'wsl-stable', 'wsl-dev'];

  async query<Row>(sql: string, values: readonly unknown[] = []) {
    this.calls.push({ sql, values });
    if (sql.includes('from machine_memberships') && sql.includes('for update')) {
      const requested = values[1] as string[];
      return {
        rows: requested
          .filter((id) => this.ownedConnectorIds.includes(id))
          .map((machine_id) => ({ machine_id })) as Row[]
      };
    }
    if (sql.includes('insert into physical_machines')) {
      return { rows: [{ id: values[0], kind: values[2], name: values[3] }] as Row[] };
    }
    if (sql.includes('delete from physical_machines')) {
      return { rows: (this.deleteAllowed ? [{ id: values[0] }] : []) as Row[] };
    }
    if (sql.includes('from physical_machines machine')) {
      return {
        rows: [{
          connector_ids: ['windows', 'wsl-dev', 'wsl-stable'],
          id: '11111111-1111-4111-8111-111111111111',
          kind: 'physical',
          name: 'os-pc'
        }] as Row[]
      };
    }
    return { rows: [] as Row[] };
  }

  async transaction<Result>(operation: (client: DatabaseQueryClient) => Promise<Result>) {
    return operation(this);
  }
}

describe('physical machine repository', () => {
  test('persists explicit connector IDs with one physical-machine membership per connector', async () => {
    const client = new PhysicalMachineClient();
    const repository = new ProjectSpaceDatabaseRepository(
      client,
      () => '11111111-1111-4111-8111-111111111111'
    );

    const machine = await repository.savePhysicalMachine({
      connectorIds: ['windows', 'wsl-stable', 'wsl-dev', 'wsl-dev'],
      kind: 'physical',
      name: 'os-pc',
      userId: 'user-1'
    });

    expect(machine).toEqual({
      connectorIds: ['windows', 'wsl-stable', 'wsl-dev'],
      id: '11111111-1111-4111-8111-111111111111',
      kind: 'physical',
      name: 'os-pc'
    });
    expect(client.calls.some(({ sql }) => sql.includes('unnest($3::text[])'))).toBe(true);
    expect(client.calls.some(({ sql }) => (
      sql.includes('on conflict (owner_user_id, connector_id)') &&
      sql.includes('physical_machine_id = excluded.physical_machine_id')
    ))).toBe(true);
    expect(client.calls.some(({ sql }) => sql.includes('delete from physical_machines machine'))).toBe(false);
  });

  test('fails closed when any connector is not owned by the authenticated account', async () => {
    const client = new PhysicalMachineClient();
    const repository = new ProjectSpaceDatabaseRepository(client);

    await expect(repository.savePhysicalMachine({
      connectorIds: ['windows', 'someone-elses-connector'],
      kind: 'physical',
      name: 'os-pc',
      userId: 'user-1'
    })).rejects.toThrow('Only connector installations owned by this account can be grouped.');
    expect(client.calls.some(({ sql }) => sql.includes('insert into physical_machines'))).toBe(false);
  });

  test('lists and deletes only within the authenticated owner scope', async () => {
    const client = new PhysicalMachineClient();
    const repository = new ProjectSpaceDatabaseRepository(client);

    expect(await repository.listPhysicalMachines('user-1')).toEqual([{
      connectorIds: ['windows', 'wsl-dev', 'wsl-stable'],
      id: '11111111-1111-4111-8111-111111111111',
      kind: 'physical',
      name: 'os-pc'
    }]);
    expect(await repository.deletePhysicalMachine({
      physicalMachineId: '11111111-1111-4111-8111-111111111111',
      userId: 'user-1'
    })).toBe(true);

    const deleteCall = client.calls.find(({ sql }) => (
      sql.includes('delete from physical_machines machine')
    ));
    expect(deleteCall?.values).toEqual([
      '11111111-1111-4111-8111-111111111111',
      'user-1'
    ]);
    expect(deleteCall?.sql).toContain('from machine_connection_requests request');
  });

  test('creates empty machines and refuses to delete occupied machines', async () => {
    const client = new PhysicalMachineClient();
    const repository = new ProjectSpaceDatabaseRepository(
      client,
      () => '22222222-2222-4222-8222-222222222222'
    );

    await expect(repository.savePhysicalMachine({
      connectorIds: [],
      kind: 'virtual',
      name: 'ChatGPT-Work-VM',
      userId: 'user-1'
    })).resolves.toEqual({
      connectorIds: [],
      id: '22222222-2222-4222-8222-222222222222',
      kind: 'virtual',
      name: 'ChatGPT-Work-VM'
    });

    client.deleteAllowed = false;
    await expect(repository.deletePhysicalMachine({
      physicalMachineId: '11111111-1111-4111-8111-111111111111',
      userId: 'user-1'
    })).resolves.toBe(false);
  });
});
