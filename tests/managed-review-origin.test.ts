import { describe, expect, test } from 'bun:test';
import { managedReviewRedirectUrl } from '../src/auth/managed-review-origin';

describe('managed review origin', () => {
  test('moves an insecure Tailnet entry URL to its CLI-owned local review origin', () => {
    expect(managedReviewRedirectUrl(
      'http://100.80.135.9:44000/settings?tab=compute#device',
      false,
      'http://issue-732.project-space.localhost:1355'
    )).toBe('http://issue-732.project-space.localhost:1355/settings?tab=compute#device');
  });

  test('does not redirect secure, non-Tailnet, or untrusted target origins', () => {
    expect(managedReviewRedirectUrl(
      'http://100.80.135.9:44000/settings',
      true,
      'http://issue-732.project-space.localhost:1355'
    )).toBeUndefined();
    expect(managedReviewRedirectUrl(
      'http://192.168.1.4:44000/settings',
      false,
      'http://issue-732.project-space.localhost:1355'
    )).toBeUndefined();
    expect(managedReviewRedirectUrl(
      'http://100.80.135.9:44000/settings',
      false,
      'https://review.example.com'
    )).toBeUndefined();
  });
});
