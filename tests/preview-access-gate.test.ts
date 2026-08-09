import { expect, test } from 'bun:test';

import {
  directPrototypeChangeId,
  normalizePreviewReturnTarget,
  parsePreviewAccessGateSearch,
  previewAccessGateUrl,
  previewSurfaceUrl
} from '../src/shared/preview-access-gate';

test('builds stable full Preview and Prototype URLs on the exact PR domain', () => {
  expect(previewSurfaceUrl(528, 'full')).toBe('https://pr-528.projects.os-home.net/');
  expect(previewSurfaceUrl(528, 'full', 'http://pr-528.localhost:4173')).toBe(
    'http://pr-528.localhost:4173/'
  );
  const prototype = new URL(previewSurfaceUrl(528, 'prototype')!);
  expect(prototype.origin).toBe('https://pr-528.projects.os-home.net');
  expect(prototype.pathname).toBe('/prototype/desktop/');
  expect(prototype.searchParams.get('change')).toBe(directPrototypeChangeId);
  expect(prototype.searchParams.get('scenario')).toBe('ready');
  expect(prototype.searchParams.get('viewport')).toBe('desktop');
});

test('normalizes direct prototype entry and parses the scoped gate target', () => {
  expect(normalizePreviewReturnTarget('/prototype/desktop/?scenario=ready', 528)).toBe(
    '/prototype/desktop/?scenario=ready&change=direct-preview'
  );
  const href = previewAccessGateUrl(
    'https://pr.projects.os-home.net',
    528,
    '/prototype/desktop/?scenario=ready'
  );
  const gate = new URL(href!);
  const parsed = parsePreviewAccessGateSearch(gate.search);
  expect(parsed).toEqual({
    changeId: directPrototypeChangeId,
    pullRequestNumber: 528,
    returnTarget: '/prototype/desktop/?scenario=ready&change=direct-preview',
    surface: 'prototype',
    surfaceKind: 'desktop-prototype',
    targetUrl: 'https://pr-528.projects.os-home.net/prototype/desktop/?scenario=ready&change=direct-preview'
  });
});

test('parses a normal full Preview destination without routing through the Prototype review', () => {
  expect(parsePreviewAccessGateSearch(
    '?pr=528&return=%2Fprojects%2Fproject-space%3Ftab%3Dissues'
  )).toEqual({
    pullRequestNumber: 528,
    returnTarget: '/projects/project-space?tab=issues',
    surface: 'full',
    targetUrl: 'https://pr-528.projects.os-home.net/projects/project-space?tab=issues'
  });
});

test('rejects cross-origin, API, fragment, duplicate, and unknown gate targets', () => {
  expect(normalizePreviewReturnTarget('//attacker.example/path', 528)).toBeUndefined();
  expect(normalizePreviewReturnTarget('/api', 528)).toBeUndefined();
  expect(normalizePreviewReturnTarget('/api/projects', 528)).toBeUndefined();
  expect(normalizePreviewReturnTarget('/safe#fragment', 528)).toBeUndefined();
  expect(parsePreviewAccessGateSearch('?pr=528&pr=529&return=%2F')).toBeUndefined();
  expect(parsePreviewAccessGateSearch('?pr=528&return=%2F&next=evil')).toBeUndefined();
  expect(parsePreviewAccessGateSearch(
    '?pr=528&return=%2Fprototype%2Fdesktop%2F%3Fchange%3Dbad_value'
  )).toBeUndefined();
});
