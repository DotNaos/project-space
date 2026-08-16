import { expect, test } from 'bun:test';

import { legacyConnectorRemovalMigrationId, legacyConnectorRemovalMigrationSql } from '../server/database/legacy-connector-removal-migration';
import { databaseMigrations } from '../server/database/migrations';

test('legacy Connector receipt migration is registered and never cascades legacy resources', () => {
  expect(databaseMigrations.find(({ id }) => id === legacyConnectorRemovalMigrationId)?.sql).toBe(legacyConnectorRemovalMigrationSql);
  expect(legacyConnectorRemovalMigrationSql).toContain('legacy_connector_removal_receipts');
  expect(legacyConnectorRemovalMigrationSql).toContain('create or replace function project_space_ensure_connector_environment()');
  expect(legacyConnectorRemovalMigrationSql).toContain('receipt.connector_id = new.machine_id');
  expect(legacyConnectorRemovalMigrationSql).not.toContain('on delete cascade');
  expect(legacyConnectorRemovalMigrationSql).not.toContain('connector_credentials');
});
