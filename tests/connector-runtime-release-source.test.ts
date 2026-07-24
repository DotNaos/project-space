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

  test('permits only the immutable Linux bridge release and caches it separately', async () => {
    const calls: string[] = [];
    const source = new GitHubConnectorRuntimeReleaseSource('v0.5.0', async (url) => {
      calls.push(url);
      return Response.json({ manifest: { releaseId: url.includes('v0.4.14')
        ? 'v0.4.14'
        : 'v0.5.0' }, signature: 'signed' });
    });

    await source.loadApprovedManifest();
    await source.loadApprovedManifest('v0.4.14');
    await source.loadApprovedManifest('v0.4.14');
    expect(calls).toEqual([
      connectorRuntimeReleaseManifestUrl('v0.5.0'),
      connectorRuntimeReleaseManifestUrl('v0.4.14')
    ]);
    await expect(source.loadApprovedManifest('v0.4.13')).rejects.toMatchObject({
      code: 'release-mismatch'
    });
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
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);

    const oversized = new GitHubConnectorRuntimeReleaseSource('v0.5.0', async () =>
      new Response('{}', { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } })
    );
    await expect(oversized.loadApprovedManifest()).rejects.toMatchObject({
      code: 'unavailable'
    });
  });

  test('aborts and rejects a manifest fetch that exceeds its deadline', async () => {
    let aborted = false;
    const source = new GitHubConnectorRuntimeReleaseSource(
      'v0.5.0',
      async (_url, init) => new Promise<Response>((_resolve, reject) => {
        const signal = init.signal;
        if (!signal) return;
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(signal.reason);
        }, { once: true });
      }),
      () => 1_000,
      5_000,
      10
    );

    await expect(source.loadApprovedManifest()).rejects.toMatchObject({
      code: 'unavailable'
    });
    expect(aborted).toBe(true);
  });

  test('coalesces concurrent loads and gives each caller an isolated value', async () => {
    let calls = 0;
    let finishFetch!: (response: Response) => void;
    const pendingResponse = new Promise<Response>((resolve) => {
      finishFetch = resolve;
    });
    const source = new GitHubConnectorRuntimeReleaseSource(
      'v0.5.0',
      async () => {
        calls += 1;
        return pendingResponse;
      }
    );

    const firstLoad = source.loadApprovedManifest();
    const secondLoad = source.loadApprovedManifest('v0.5.0');
    expect(calls).toBe(1);
    finishFetch(Response.json({ manifest: { releaseId: 'v0.5.0' }, signature: 'signed' }));

    const [first, second] = await Promise.all([firstLoad, secondLoad]) as Array<{
      manifest: { releaseId: string };
      signature: string;
    }>;
    expect(calls).toBe(1);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    first.manifest.releaseId = 'changed-by-first-caller';
    expect(second.manifest.releaseId).toBe('v0.5.0');
  });

  test('does not retain a failed in-flight load', async () => {
    let calls = 0;
    const source = new GitHubConnectorRuntimeReleaseSource('v0.5.0', async () => {
      calls += 1;
      if (calls === 1) throw new Error('temporary failure');
      return Response.json({ manifest: {}, signature: 'signed' });
    });

    const firstLoad = source.loadApprovedManifest();
    const secondLoad = source.loadApprovedManifest();
    await expect(Promise.all([firstLoad, secondLoad])).rejects.toMatchObject({
      code: 'unavailable'
    });
    expect(calls).toBe(1);

    await expect(source.loadApprovedManifest()).resolves.toEqual({
      manifest: {}, signature: 'signed'
    });
    expect(calls).toBe(2);
  });
});
