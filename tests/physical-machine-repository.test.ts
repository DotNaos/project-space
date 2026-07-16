import { describe, expect, test } from 'bun:test';

import type { DatabaseQueryClient } from '../server/database/client';
import { ProjectSpaceDatabaseRepository } from '../server/database/repository';

class PhysicalMachineClient implements DatabaseQueryClient {
  readonly calls: Array<{ sql: string; values: readonly unknown[] }> = [];
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
      return { rows: [{ id: values[0], name: values[2] }] as Row[] };
    }
    if (sql.includes('from physical_machines machine')) {
      return {
        rows: [{
          connector_ids: ['windows', 'wsl-dev', 'wsl-stable'],
          id: '11111111-1111-4111-8111-111111111111',
          name: 'os-pc'
        }] as Row[]
      };
    }
    if (sql.includes('delete from physical_machines')) {
      return { rows: [{ id: values[0] }] as Row[] };
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
      name: 'os-pc',
      userId: 'user-1'
    });

    expect(machine).toEqual({
      connectorIds: ['windows', 'wsl-stable', 'wsl-dev'],
      id: '11111111-1111-4111-8111-111111111111',
      name: 'os-pc'
    });
    expect(client.calls.some(({ sql }) => sql.includes('unnest($3::text[])'))).toBe(true);
    expect(client.calls.some(({ sql }) => (
      sql.includes('on conflict (owner_user_id, connector_id)') &&
      sql.includes('physical_machine_id = excluded.physical_machine_id')
    ))).toBe(true);
    expect(client.calls.some(({ sql }) => (
      sql.includes('delete from physical_machines machine') &&
      sql.includes('not exists')
    ))).toBe(true);
  });

  test('fails closed when any connector is not owned by the authenticated account', async () => {
    const client = new PhysicalMachineClient();
    const repository = new ProjectSpaceDatabaseRepository(client);

    await expect(repository.savePhysicalMachine({
      connectorIds: ['windows', 'someone-elses-connector'],
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
      name: 'os-pc'
    }]);
    expect(await repository.deletePhysicalMachine({
      physicalMachineId: '11111111-1111-4111-8111-111111111111',
      userId: 'user-1'
    })).toBe(true);

    const deleteCall = client.calls.find(({ sql }) => (
      sql.includes('delete from physical_machines\n        where')
    ));
    expect(deleteCall?.values).toEqual([
      '11111111-1111-4111-8111-111111111111',
      'user-1'
    ]);
  });
});
