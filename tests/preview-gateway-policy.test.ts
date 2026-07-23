import { afterEach, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import {
  createPreviewIdentityHeaders,
  derivePreviewOrigin,
  isGitHubApiPath,
  isBlockedPreviewPath,
  isTrustedGitHubBrokerRequest,
  parsePreviewGatewayBinding,
  previewIdentityHeader,
  previewSignatureHeader,
  readPreviewIdentityAssertion
} from '../server/preview-gateway-policy';
import { readAuthSessionFromRequest } from '../server/local-auth-store';

const secret = 'preview-only-secret-that-is-long-enough-for-hmac';
const binding = {
  headSha: 'a'.repeat(40),
  origin: 'https://pr-263.projects.os-home.net',
  pullRequestNumber: 263,
  repositoryFullName: 'DotNaos/project-space'
};
const session = {
  email: 'operator@example.com',
  login: 'operator@example.com',
  role: 'user' as const,
  userId: 'user_123'
};

function requestWith(headers: Record<string, string>) {
  return { headers } as unknown as IncomingMessage;
}

const originalEnvironment = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnvironment)) delete process.env[key];
  }
  Object.assign(process.env, originalEnvironment);
});

describe('Preview gateway policy', () => {
  test('derives only the approved PR hostname', () => {
    expect(derivePreviewOrigin(263)).toBe('https://pr-263.projects.os-home.net');
    expect(() => derivePreviewOrigin(0)).toThrow();
    expect(() => derivePreviewOrigin(263, 'bad/domain')).toThrow();
  });

  test('parses a binding only when the origin and PR agree', () => {
    expect(parsePreviewGatewayBinding({
      PROJECT_SPACE_PREVIEW_HEAD_SHA: binding.headSha,
      PROJECT_SPACE_PREVIEW_PR_NUMBER: '263',
      PROJECT_SPACE_PREVIEW_REPOSITORY: binding.repositoryFullName,
      PROJECT_SPACE_PUBLIC_ORIGIN: binding.origin
    })).toEqual(binding);
    expect(() => parsePreviewGatewayBinding({
      PROJECT_SPACE_PREVIEW_HEAD_SHA: binding.headSha,
      PROJECT_SPACE_PREVIEW_PR_NUMBER: '263',
      PROJECT_SPACE_PREVIEW_REPOSITORY: binding.repositoryFullName,
      PROJECT_SPACE_PUBLIC_ORIGIN: 'https://pr-264.projects.os-home.net'
    })).toThrow();
  });

  test('accepts a current, exactly bound assertion', () => {
    const now = new Date('2026-07-22T10:00:00.000Z');
    const headers = createPreviewIdentityHeaders({ binding, now, secret, session });
    expect(readPreviewIdentityAssertion({
      binding,
      now: new Date('2026-07-22T10:00:30.000Z'),
      request: requestWith(headers),
      secret
    })).toEqual(session);
  });

  test('rejects tampering, expiry, and a different PR/SHA binding', () => {
    const now = new Date('2026-07-22T10:00:00.000Z');
    const headers = createPreviewIdentityHeaders({ binding, now, secret, session });
    expect(readPreviewIdentityAssertion({
      binding,
      now: new Date('2026-07-22T10:01:01.000Z'),
      request: requestWith(headers),
      secret
    })).toBeNull();
    expect(readPreviewIdentityAssertion({
      binding: { ...binding, headSha: 'b'.repeat(40) },
      now,
      request: requestWith(headers),
      secret
    })).toBeNull();
    expect(readPreviewIdentityAssertion({
      binding,
      now,
      request: requestWith({ ...headers, [previewSignatureHeader]: 'tampered' }),
      secret
    })).toBeNull();
  });

  test('rejects a valid signature over an assertion with an unsafe audience', () => {
    const payload = Buffer.from(JSON.stringify({
      ...binding,
      audience: 'production',
      expiresAt: 1_800_000_060,
      issuedAt: 1_800_000_000,
      session,
      version: 1
    })).toString('base64url');
    const signature = createHmac('sha256', secret).update(payload).digest('base64url');
    expect(readPreviewIdentityAssertion({
      binding,
      now: new Date(1_800_000_010 * 1000),
      request: requestWith({
        [previewIdentityHeader]: payload,
        [previewSignatureHeader]: signature
      }),
      secret
    })).toBeNull();
  });

  test('keeps raw infrastructure and machine operations out of Preview', () => {
    expect(isBlockedPreviewPath('/api/platform/deploy-project')).toBe(true);
    expect(isBlockedPreviewPath('/api/connectors/credentials')).toBe(true);
    expect(isBlockedPreviewPath('/api/github/catalog')).toBe(false);
    expect(isGitHubApiPath('/api/github/catalog')).toBe(true);
    expect(isTrustedGitHubBrokerRequest('GET', '/api/github/catalog')).toBe(true);
    expect(isTrustedGitHubBrokerRequest('GET', '/api/auth/session')).toBe(true);
    expect(isTrustedGitHubBrokerRequest('POST', '/api/github/history')).toBe(true);
    expect(isTrustedGitHubBrokerRequest('POST', '/api/github/issues')).toBe(false);
    expect(isTrustedGitHubBrokerRequest('DELETE', '/api/github/branches')).toBe(false);
    expect(isTrustedGitHubBrokerRequest('GET', '/api/github/raw-proxy')).toBe(false);
  });

  test('Preview runtime accepts only the gateway assertion, never a bearer token', async () => {
    Object.assign(process.env, {
      PROJECT_SPACE_AUTH_DISABLED: '0',
      PROJECT_SPACE_PREVIEW_GATEWAY_SECRET: secret,
      PROJECT_SPACE_PREVIEW_HEAD_SHA: binding.headSha,
      PROJECT_SPACE_PREVIEW_MODE: '1',
      PROJECT_SPACE_PREVIEW_PR_NUMBER: '263',
      PROJECT_SPACE_PREVIEW_REPOSITORY: binding.repositoryFullName,
      PROJECT_SPACE_PUBLIC_ORIGIN: binding.origin
    });
    const headers = createPreviewIdentityHeaders({ binding, secret, session });
    expect(await readAuthSessionFromRequest(requestWith(headers))).toEqual(session);
    expect(await readAuthSessionFromRequest(requestWith({ authorization: 'Bearer clerk-token' })))
      .toBeNull();
  });
});
