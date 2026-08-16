import { describe, expect, test } from 'bun:test';

import { LegacyConnectorCleanupService } from '../server/legacy-connector-cleanup/service';
import type { LegacyConnectorCleanupStore } from '../server/legacy-connector-cleanup/service';

const target = { connectorId: 'legacy-a', fingerprint: 'a'.repeat(64) };

describe('legacy Connector cleanup service', () => {
  test('keeps partial removal outcomes intact', async () => {
    const store: LegacyConnectorCleanupStore = {
      async listSnapshot() { return { records: [], schemaVersion: 1 }; },
      async remove(_owner, request) {
        return { requestId: request.requestId, results: [
          { ...target, outcome: 'removed' as const },
          { blockers: [{ count: 1, kind: 'task_execution' as const }], connectorId: 'legacy-b', fingerprint: 'b'.repeat(64), outcome: 'blocked' as const }
        ] };
      }
    };
    const result = await new LegacyConnectorCleanupService(store).remove('owner-one', { actorId: 'owner-one', records: [target], requestId: 'request-1' });
    expect(result.results).toEqual([expect.objectContaining({ outcome: 'removed' }), expect.objectContaining({ outcome: 'blocked' })]);
  });
});
