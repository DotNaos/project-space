import { describe, expect, test } from 'bun:test';

import {
  decryptGitHubOAuthToken,
  encryptGitHubOAuthToken,
  GitHubOAuthTokenEncryptionConfigurationError,
  GitHubOAuthTokenUnreadableError,
  hasDedicatedGitHubOAuthTokenEncryptionKey
} from '../server/github-oauth-token-encryption';

const databaseUrl = 'postgres://project-space.test/database';
const dedicatedKey = 'dedicated-storage-key-with-32-characters';

describe('GitHub OAuth token encryption', () => {
  test('reports whether the independent storage key is configured', () => {
    expect(hasDedicatedGitHubOAuthTokenEncryptionKey({})).toBe(false);
    expect(hasDedicatedGitHubOAuthTokenEncryptionKey({
      PROJECT_SPACE_TOKEN_ENCRYPTION_KEY: 'too-short'
    })).toBe(false);
    expect(hasDedicatedGitHubOAuthTokenEncryptionKey({
      PROJECT_SPACE_TOKEN_ENCRYPTION_KEY: dedicatedKey
    })).toBe(true);
  });

  test('keeps stored tokens independent from Clerk credential rotation', () => {
    const encrypted = encryptGitHubOAuthToken('github-token', {
      databaseUrl,
      environment: {
        CLERK_SECRET_KEY: 'old-clerk-key',
        PROJECT_SPACE_TOKEN_ENCRYPTION_KEY: dedicatedKey
      }
    });
    const decrypted = decryptGitHubOAuthToken(encrypted, {
      databaseUrl,
      environment: {
        CLERK_SECRET_KEY: 'new-clerk-key',
        PROJECT_SPACE_TOKEN_ENCRYPTION_KEY: dedicatedKey
      }
    });

    expect(decrypted).toEqual({ token: 'github-token', usedLegacyKey: false });
  });

  test('reads a legacy Clerk-encrypted token once a dedicated key is configured', () => {
    const encrypted = encryptGitHubOAuthToken('github-token', {
      databaseUrl,
      environment: { CLERK_SECRET_KEY: 'legacy-clerk-key' }
    });
    const decrypted = decryptGitHubOAuthToken(encrypted, {
      databaseUrl,
      environment: {
        CLERK_SECRET_KEY: 'legacy-clerk-key',
        PROJECT_SPACE_TOKEN_ENCRYPTION_KEY: dedicatedKey
      }
    });

    expect(decrypted).toEqual({ token: 'github-token', usedLegacyKey: true });
  });

  test('turns an unreadable token into a safe reconnect error', () => {
    const encrypted = encryptGitHubOAuthToken('private-github-token', {
      databaseUrl,
      environment: { CLERK_SECRET_KEY: 'old-clerk-key' }
    });

    expect(() => decryptGitHubOAuthToken(encrypted, {
      databaseUrl: 'postgres://different/database',
      environment: { CLERK_SECRET_KEY: 'new-clerk-key' }
    })).toThrow(GitHubOAuthTokenUnreadableError);

    try {
      decryptGitHubOAuthToken(encrypted, {
        databaseUrl: 'postgres://different/database',
        environment: { CLERK_SECRET_KEY: 'new-clerk-key' }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain('Reconnect GitHub');
      expect(message).not.toContain('private-github-token');
      expect(message).not.toContain('old-clerk-key');
      expect(message).not.toContain('Unsupported state');
    }
  });

  test('fails safely when no encryption source is configured', () => {
    expect(() => encryptGitHubOAuthToken('github-token', {
      databaseUrl: '',
      environment: {}
    })).toThrow(GitHubOAuthTokenEncryptionConfigurationError);
  });

  test('rejects a weak dedicated encryption key', () => {
    expect(() => encryptGitHubOAuthToken('github-token', {
      databaseUrl,
      environment: { PROJECT_SPACE_TOKEN_ENCRYPTION_KEY: 'too-short' }
    })).toThrow(GitHubOAuthTokenEncryptionConfigurationError);
  });
});
