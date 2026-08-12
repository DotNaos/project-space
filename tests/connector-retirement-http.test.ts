import { createServer } from 'node:http';

import { describe, expect, test } from 'bun:test';

import { createConnectorRetirementHttpApi } from '../server/connector-retirement/http';
import { MemoryConnectorCompatibilityUsageStore } from '../server/connector-retirement/memory-store';
import { ConnectorRetirementService } from '../server/connector-retirement/service';

function retirementService() {
  return new ConnectorRetirementService(new MemoryConnectorCompatibilityUsageStore(), {
    failureContractReleased: false,
    legacyGlobalCredentialDisabled: true,
    maximumEvidenceAgeSeconds: 900,
    replacementProofs: {},
    replacementProofsVerified: false,
    requiredObservationSeconds: 30 * 24 * 60 * 60
  }, () => new Date('2026-08-12T10:00:00.000Z'));
}

describe('private Connector retirement report', () => {
  test('denies an unauthenticated report without exposing evidence', async () => {
    const handler = createConnectorRetirementHttpApi({
      loadService: async () => retirementService(),
      resolveOwnerUserId: async () => undefined
    });
    const fixture = await start(handler);
    try {
      const response = await fetch(`${fixture.origin}/api/connector-retirement/report`);
      expect(response.status).toBe(403);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(await response.json()).toEqual({ error: 'Owner authentication is required.' });
    } finally {
      await fixture.close();
    }
  });

  test('returns only the authenticated owner report and rejects ambiguous requests', async () => {
    let resolvedOwner = '';
    const handler = createConnectorRetirementHttpApi({
      loadService: async () => retirementService(),
      resolveOwnerUserId: async (_request, authenticatedOwnerUserId) => {
        resolvedOwner = authenticatedOwnerUserId ?? '';
        return authenticatedOwnerUserId;
      }
    });
    const fixture = await start(handler, 'owner-one');
    try {
      const response = await fetch(`${fixture.origin}/api/connector-retirement/report`);
      expect(response.status).toBe(200);
      expect(resolvedOwner).toBe('owner-one');
      const body = await response.json() as Record<string, unknown>;
      expect(body).not.toHaveProperty('ownerUserId');
      expect(body).not.toHaveProperty('request');

      expect((await fetch(`${fixture.origin}/api/connector-retirement/report?owner=other`)).status)
        .toBe(405);
      expect((await fetch(`${fixture.origin}/api/connector-retirement/report`, {
        method: 'POST'
      })).status).toBe(405);
    } finally {
      await fixture.close();
    }
  });
});

async function start(
  handler: ReturnType<typeof createConnectorRetirementHttpApi>,
  ownerUserId?: string
) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (!await handler(request, response, url, ownerUserId)) response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server unavailable');
  return {
    close: () => new Promise<void>((resolve, reject) => server.close((error) =>
      error ? reject(error) : resolve()
    )),
    origin: `http://127.0.0.1:${address.port}`
  };
}
