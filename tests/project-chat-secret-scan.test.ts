import { describe, expect, test } from 'bun:test';
import { scanProjectChatText } from '../server/project-chat/secret-scan';

describe('Project Chat secret scanning', () => {
  test.each([
    'PR #128 is ready for review.',
    'Use @mira after the worktree is free.',
    'The password policy should require 16 characters.',
    'Render <strong> as literal text, not HTML.',
    'postgresql connections should use TLS'
  ])('allows ordinary coordination text: %s', (message) => {
    expect(scanProjectChatText(message)).toEqual({ safe: true });
  });

  test.each([
    '-----BEGIN OPENSSH PRIVATE KEY-----\nredacted',
    '-----BEGIN ENCRYPTED PRIVATE KEY-----\nredacted',
    `github_pat_${'a'.repeat(30)}`,
    `ghp_${'a'.repeat(32)}`,
    `glpat-${'a'.repeat(30)}`,
    `sk-proj-${'a'.repeat(30)}`,
    `sk_live_${'a'.repeat(30)}`,
    `AKIA${'A'.repeat(16)}`,
    `ASIA${'A'.repeat(16)}`,
    `AWS_SECRET_ACCESS_KEY=${'a'.repeat(40)}`,
    `Authorization: Bearer ${'a'.repeat(32)}`,
    `Authorization: Basic ${'a'.repeat(32)}`,
    `eyJ${'a'.repeat(12)}.${'b'.repeat(12)}.${'c'.repeat(12)}`,
    'Cookie: session=super-secret-value',
    'password=correct-horse-battery-staple',
    'PROJECT_API_KEY=0123456789abcdefghijkl',
    'postgres://service:super-secret@database.internal/project'
  ])('rejects representative secret material without classifying it: %s', (message) => {
    expect(scanProjectChatText(message)).toEqual({ safe: false });
  });
});
