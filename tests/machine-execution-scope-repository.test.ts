import { describe, expect, test } from 'bun:test';

import type { DatabaseQueryClient } from '../server/database/client';
import { ProjectSpaceDatabaseRepository } from '../server/database/repository';

class ScopeClient implements DatabaseQueryClient {
  readonly calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  ownedMachineIds = ['windows', 'wsl-stable', 'wsl-dev'];

  async query<Row>(sql: string, values: readonly unknown[] = []) {
    this.calls.push({ sql, values });
    if (sql.includes('from machine_memberships') && sql.includes('for update')) {
      const requested = values[1] as string[];
      return {
        rows: requested
          .filter((id) => this.ownedMachineIds.includes(id))
          .map((machine_id) => ({ machine_id })) as Row[]
      };
    }
    if (sql.includes('insert into machine_execution_scopes')) {
      return { rows: [{ id: values[0], name: values[2] }] as Row[] };
    }
    if (sql.includes('from machine_execution_scopes scope')) {
      return {
        rows: [{
          id: '11111111-1111-4111-8111-111111111111',
          machine_ids: ['windows', 'wsl-dev', 'wsl-stable'],
          name: 'os-pc'
        }] as Row[]
      };
    }
    if (sql.includes('delete from machine_execution_scopes')) {
      return { rows: [{ id: values[0] }] as Row[] };
    }
    return { rows: [] as Row[] };
  }

  async transaction<Result>(operation: (client: DatabaseQueryClient) => Promise<Result>) {
    return operation(this);
  }
}

describe('machine execution scope repository', () => {
  test('persists an explicit owner-scoped mapping without consulting display names', async () => {
    const client = new ScopeClient();
    const repository = new ProjectSpaceDatabaseRepository(
      client,
      () => '11111111-1111-4111-8111-111111111111'
    );

    const scope = await repository.saveMachineExecutionScope({
      machineIds: ['windows', 'wsl-stable', 'wsl-dev', 'wsl-dev'],
      name: 'os-pc',
      userId: 'user-1'
    });

    expect(scope).toEqual({
      id: '11111111-1111-4111-8111-111111111111',
      machineIds: ['windows', 'wsl-stable', 'wsl-dev'],
      name: 'os-pc'
    });
    expect(client.calls.some(({ sql }) => sql.includes('unnest($3::text[])'))).toBe(true);
    expect(client.calls.some(({ sql }) => sql.includes('on conflict (owner_user_id, machine_id)'))).toBe(true);
    expect(client.calls.some(({ sql }) => (
      sql.includes('delete from machine_execution_scopes scope') &&
      sql.includes('not exists')
    ))).toBe(true);
  });

  test('fails closed when any connector is not owned by the authenticated account', async () => {
    const client = new ScopeClient();
    const repository = new ProjectSpaceDatabaseRepository(client);

    await expect(repository.saveMachineExecutionScope({
      machineIds: ['windows', 'someone-elses-machine'],
      name: 'os-pc',
      userId: 'user-1'
    })).rejects.toThrow('Only connector instances owned by this account can be grouped.');
    expect(client.calls.some(({ sql }) => sql.includes('insert into machine_execution_scopes'))).toBe(false);
  });

  test('lists and deletes only within the authenticated owner scope', async () => {
    const client = new ScopeClient();
    const repository = new ProjectSpaceDatabaseRepository(client);

    expect(await repository.listMachineExecutionScopes('user-1')).toEqual([{
      id: '11111111-1111-4111-8111-111111111111',
      machineIds: ['windows', 'wsl-dev', 'wsl-stable'],
      name: 'os-pc'
    }]);
    expect(await repository.deleteMachineExecutionScope({
      scopeId: '11111111-1111-4111-8111-111111111111',
      userId: 'user-1'
    })).toBe(true);

    const deleteCall = client.calls.find(({ sql }) => sql.includes('delete from machine_execution_scopes'));
    expect(deleteCall?.values).toEqual([
      '11111111-1111-4111-8111-111111111111',
      'user-1'
    ]);
  });
});
