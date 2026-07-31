import { expect, test } from 'bun:test';
import { previewHubReturnUrl, sanitizePreviewReturnTarget } from '../server/preview-return-target';
import { previewHubRedirectForOfflineHost } from '../server/project-space-http';
import { isPreviewHubHostname, previewPullRequestNumberFromHostname } from '../src/shared/preview-host';

test('binds return paths to the exact PR origin', () => {
  expect(sanitizePreviewReturnTarget('/prototype/desktop/?change=review', 42)).toBe('/prototype/desktop/?change=review');
  expect(sanitizePreviewReturnTarget('//evil.example/path', 42)).toBeUndefined();
  expect(sanitizePreviewReturnTarget('https://evil.example/', 42)).toBeUndefined();
  expect(sanitizePreviewReturnTarget('/safe#external', 42)).toBeUndefined();
  expect(previewHubReturnUrl('/prototype/desktop/?change=review', 42)).toContain('pr=42');
});

test('recognizes only the production preview hostname shape', () => {
  expect(previewPullRequestNumberFromHostname('pr-42.projects.os-home.net')).toBe(42);
  expect(previewPullRequestNumberFromHostname('PR-42.PROJECTS.OS-HOME.NET')).toBe(42);
  expect(previewPullRequestNumberFromHostname('pr-0.projects.os-home.net')).toBeUndefined();
  expect(previewPullRequestNumberFromHostname('pr-42.evil.example')).toBeUndefined();
  expect(isPreviewHubHostname('pr.projects.os-home.net')).toBe(true);
  expect(isPreviewHubHostname('pr-42.projects.os-home.net')).toBe(true);
});

test('canonicalizes offline wildcard requests to the central hub with a bounded return target', () => {
  expect(previewHubRedirectForOfflineHost(
    'pr-263.projects.os-home.net',
    '/deep/path',
    '?filter=ready'
  )).toBe('https://pr.projects.os-home.net/?pr=263&return=%2Fdeep%2Fpath%3Ffilter%3Dready');
  expect(previewHubRedirectForOfflineHost('pr-263.projects.os-home.net', '//attacker.example', ''))
    .toBe('https://pr.projects.os-home.net/?pr=263');
  expect(previewHubRedirectForOfflineHost('projects.os-home.net', '/', '')).toBeUndefined();
});
