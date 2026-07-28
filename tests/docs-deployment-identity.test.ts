import { describe, expect, test } from 'bun:test';

import {
  docsDeploymentPresentation,
  resolveDocsDeploymentIdentity,
  unavailableDocsDeploymentIdentity,
} from '../apps/docs/lib/deployment-identity';

const commit = '18cc1b3a6f7da305ee19421de082699720a26e26';
const previewMetadata = {
  commit,
  commitShort: 'contradictory-value-is-not-used',
  preview: {
    identity: {
      headSha: commit,
      pullRequestNumber: 361,
      repositoryFullName: 'DotNaos/project-space',
    },
    state: 'verified',
  },
  version: '0.4.36',
};

describe('Docs deployment identity', () => {
  test('accepts exact Preview metadata for the current PR host', () => {
    expect(
      resolveDocsDeploymentIdentity(
        previewMetadata,
        'pr-361.projects.os-home.net',
      ),
    ).toEqual({
      backHref: '/',
      backLabel: 'Back to PR Preview',
      commit,
      pullRequestNumber: 361,
      state: 'preview',
      version: '0.4.36',
    });
  });

  test('accepts production metadata only without Preview identity', () => {
    expect(
      resolveDocsDeploymentIdentity(
        { commit, version: '0.4.36' },
        'projects.os-home.net',
      ),
    ).toEqual({
      backHref: '/',
      backLabel: 'Back to Project Space',
      commit,
      state: 'production',
      version: '0.4.36',
    });
  });

  test('rejects malformed version and revision metadata', () => {
    expect(
      resolveDocsDeploymentIdentity(
        { commit: 'short', version: 'v0.4.36' },
        'projects.os-home.net',
      ),
    ).toMatchObject({
      reasonCode: 'invalid-metadata',
      state: 'unavailable',
    });
  });

  test('requires Preview identity on a PR host', () => {
    expect(
      resolveDocsDeploymentIdentity(
        { commit, version: '0.4.36' },
        'pr-361.projects.os-home.net',
      ),
    ).toMatchObject({
      backLabel: 'Back to PR Preview',
      reasonCode: 'missing-preview-identity',
      state: 'unavailable',
    });
  });

  test('rejects PR, repository, and head contradictions', () => {
    for (const identity of [
      {
        ...previewMetadata.preview.identity,
        pullRequestNumber: 362,
      },
      {
        ...previewMetadata.preview.identity,
        repositoryFullName: 'someone/project-space',
      },
      {
        ...previewMetadata.preview.identity,
        headSha: 'a'.repeat(40),
      },
    ]) {
      expect(
        resolveDocsDeploymentIdentity(
          {
            ...previewMetadata,
            preview: {
              identity,
              state: 'verified',
            },
          },
          'pr-361.projects.os-home.net',
        ),
      ).toMatchObject({
        reasonCode: 'identity-mismatch',
        state: 'unavailable',
      });
    }
  });

  test('never downgrades Preview metadata to a production claim', () => {
    expect(
      resolveDocsDeploymentIdentity(
        previewMetadata,
        'projects.os-home.net',
      ),
    ).toMatchObject({
      backLabel: 'Back to Project Space',
      reasonCode: 'identity-mismatch',
      state: 'unavailable',
    });
  });

  test('keeps a same-host return link when the request fails', () => {
    expect(
      unavailableDocsDeploymentIdentity(
        'pr-361.projects.os-home.net',
        'request-failed',
      ),
    ).toEqual({
      backHref: '/',
      backLabel: 'Back to PR Preview',
      reasonCode: 'request-failed',
      state: 'unavailable',
    });
  });

  test('presents verified and unavailable metadata without inventing values', () => {
    expect(
      docsDeploymentPresentation({
        backHref: '/',
        backLabel: 'Back to PR Preview',
        commit,
        pullRequestNumber: 361,
        state: 'preview',
        version: '0.4.36',
      }),
    ).toEqual({
      backHref: '/',
      backLabel: 'Back to PR Preview',
      contextLabel: 'PR #361 Docs',
      fullRevision: commit,
      revision: '18cc1b3a',
      versionLabel: 'v0.4.36',
    });
    expect(
      docsDeploymentPresentation({
        backHref: '/',
        backLabel: 'Back to PR Preview',
        reasonCode: 'identity-mismatch',
        state: 'unavailable',
      }),
    ).toEqual({
      backHref: '/',
      backLabel: 'Back to PR Preview',
      contextLabel: 'Docs deployment',
      versionLabel: 'Version unavailable',
    });
  });
});
