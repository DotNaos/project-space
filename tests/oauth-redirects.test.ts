import { describe, expect, test } from 'bun:test';
import { clerkOAuthRedirectUrls } from '../src/auth/oauth-redirects';

describe('Clerk OAuth redirects', () => {
  test('keeps the callback and completed sign-in on the exact browser origin', () => {
    expect(clerkOAuthRedirectUrls({
      hash: '#machine',
      origin: 'https://project-space-732-2.review.vpn.os-home.net',
      pathname: '/settings',
      search: '?view=compute'
    })).toEqual({
      callbackUrl: 'https://project-space-732-2.review.vpn.os-home.net/sso-callback',
      completeUrl: 'https://project-space-732-2.review.vpn.os-home.net/settings?view=compute#machine'
    });
  });
});
