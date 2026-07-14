import { describe, expect, test } from 'bun:test';

import {
  ConnectorRuntimeReleaseSourceError,
  GitHubConnectorRuntimeReleaseSource,
  configuredConnectorRuntimeReleaseId,
  connectorRuntimeReleaseManifestUrl
} from '../server/connector-runtime-release-source';

describe('configured connector runtime release source', () => {
  test('constructs only the fixed repository asset for an exact release', () => {
    expect(connectorRuntimeReleaseManifestUrl('v0.5.0')).toBe(
      'https://github.com/DotNaos/project-space/releases/download/v0.5.0/project-space-release-manifest.json'
    );
    expect(() => connectorRuntimeReleaseManifestUrl('latest')).toThrow(
      ConnectorRuntimeReleaseSourceError
    );
    expect(configuredConnectorRuntimeReleaseId({
      PROJECT_SPACE_CONNECTOR_APPROVED_RELEASE_ID: 'v0.5.0'
    })).toBe('v0.5.0');
    expect(configuredConnectorRuntimeReleaseId({
      PROJECT_SPACE_CONNECTOR_APPROVED_RELEASE_ID: 'latest'
    })).toBeUndefined();
  });

  test('rejects a browser-selected release before fetching', async () => {
    let calls = 0;
    const source = new GitHubConnectorRuntimeReleaseSource('v0.5.0', async () => {
      calls += 1;
      return Response.json({});
    });
    await expect(source.loadApprovedManifest('v0.6.0')).rejects.toMatchObject({
      code: 'release-mismatch'
    });
    expect(calls).toBe(0);
  });

  test('uses no credentials, bounds responses, and caches the immutable exact asset', async () => {
    const calls: Array<{ init: RequestInit; url: string }> = [];
    const source = new GitHubConnectorRuntimeReleaseSource(
      'v0.5.0',
      async (url, init) => {
        calls.push({ init, url });
        return new Response(JSON.stringify({ manifest: {}, signature: 'signed' }));
      },
      () => 1_000,
      5_000
    );
    const first = await source.loadApprovedManifest();
    const second = await source.loadApprovedManifest('v0.5.0');
    expect(first).toEqual(second);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init).toMatchObject({
      cache: 'no-store', credentials: 'omit', method: 'GET', redirect: 'follow'
    });

    const oversized = new GitHubConnectorRuntimeReleaseSource('v0.5.0', async () =>
      new Response('{}', { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } })
    );
    await expect(oversized.loadApprovedManifest()).rejects.toMatchObject({
      code: 'unavailable'
    });
  });
});
