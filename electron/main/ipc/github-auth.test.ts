import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import {
  buildCodeChallenge,
  buildGitHubAuthorizeUrl,
  clearGitHubAuthSession,
  readGitHubAuthSession,
  writeGitHubAuthSession
} from './github-auth';

test('buildGitHubAuthorizeUrl includes the required GitHub OAuth parameters', () => {
  const authorizeUrl = new URL(
    buildGitHubAuthorizeUrl({
      clientId: 'client-123',
      codeVerifier: 'verifier-123',
      redirectUri: 'http://127.0.0.1:48123/auth/github/callback',
      state: 'state-123'
    })
  );

  assert.equal(authorizeUrl.origin, 'https://github.com');
  assert.equal(authorizeUrl.pathname, '/login/oauth/authorize');
  assert.equal(authorizeUrl.searchParams.get('client_id'), 'client-123');
  assert.equal(
    authorizeUrl.searchParams.get('redirect_uri'),
    'http://127.0.0.1:48123/auth/github/callback'
  );
  assert.equal(authorizeUrl.searchParams.get('scope'), 'read:user repo');
  assert.equal(authorizeUrl.searchParams.get('state'), 'state-123');
  assert.equal(authorizeUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(
    authorizeUrl.searchParams.get('code_challenge'),
    buildCodeChallenge('verifier-123')
  );
});

test('GitHub auth sessions can be persisted, loaded, and cleared', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'project-space-auth-'));
  const storagePath = join(tempDirectory, 'github-auth.json');

  try {
    assert.equal(readGitHubAuthSession(storagePath), null);

    writeGitHubAuthSession(storagePath, {
      accessToken: 'token-123',
      viewer: {
        avatarUrl: 'https://avatars.githubusercontent.com/u/123',
        login: 'oli',
        name: 'Oli'
      }
    });

    assert.deepEqual(readGitHubAuthSession(storagePath), {
      accessToken: 'token-123',
      viewer: {
        avatarUrl: 'https://avatars.githubusercontent.com/u/123',
        login: 'oli',
        name: 'Oli'
      }
    });

    clearGitHubAuthSession(storagePath);

    assert.equal(readGitHubAuthSession(storagePath), null);
  } finally {
    await rm(tempDirectory, { force: true, recursive: true });
  }
});
