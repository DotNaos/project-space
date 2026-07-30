import { describe, expect, test } from 'bun:test';

import {
  NATIVE_PROTOTYPE_STATE_OPTIONS,
  nativePrototypeIdentityFromUrl,
  nativePrototypeCapabilities,
  nativePrototypePrimaryAction,
  nativePrototypeScenarioState,
  shortNativePrototypeSha,
} from './prototype-launch-native-state.ts';

describe('native prototype launch state', () => {
  test('keeps all six launch states visible', () => {
    expect(NATIVE_PROTOTYPE_STATE_OPTIONS.map((option) => option.state)).toEqual([
      'not-started',
      'starting',
      'ready',
      'stale',
      'unavailable',
      'stopped',
    ]);
  });

  test('offers the correct primary action for each state', () => {
    expect(nativePrototypePrimaryAction('not-started')).toEqual({
      disabled: false,
      label: 'Start prototype',
    });
    expect(nativePrototypePrimaryAction('starting')).toEqual({
      disabled: true,
      label: 'Starting prototype',
    });
    expect(nativePrototypePrimaryAction('ready').label).toBe('Open prototype');
    expect(nativePrototypePrimaryAction('stale').label).toBe(
      'Reconnect exact head'
    );
    expect(nativePrototypePrimaryAction('unavailable').label).toBe(
      'Retry prototype'
    );
    expect(nativePrototypePrimaryAction('stopped').label).toBe(
      'Restart prototype'
    );
  });

  test('never exposes host capabilities to deployed previews', () => {
    expect(nativePrototypeCapabilities('deployed')).toEqual({
      annotations: false,
      codexFeedback: false,
      hostAccess: false,
      readOnly: true,
    });
    expect(nativePrototypeCapabilities('local')).toEqual({
      annotations: true,
      codexFeedback: true,
      hostAccess: false,
      readOnly: false,
    });
  });

  test('maps existing prototype scenarios to launch states', () => {
    expect(nativePrototypeScenarioState('empty')).toBe('not-started');
    expect(nativePrototypeScenarioState('loading')).toBe('starting');
    expect(nativePrototypeScenarioState('error')).toBe('unavailable');
    expect(nativePrototypeScenarioState('long-content')).toBe('stale');
    expect(nativePrototypeScenarioState('populated')).toBe('ready');
  });

  test('shows a compact exact head', () => {
    expect(shortNativePrototypeSha('646d44c1aca7a60a08be2d4a53658950b4da595b')).toBe(
      '646d44c'
    );
  });

  test('loads exact identity from the Expo or web launch URL', () => {
    const identity = nativePrototypeIdentityFromUrl(
      `projectspace://prototype?repository=DotNaos%2Fproject-space&pr=382` +
      `&issue=381&project=project-space&head=${'a'.repeat(40)}` +
      '&surface=native&branch=issue-381&machine=os-mac' +
      '&thread=019fae8d-1eae-7282-9278-b57771a9c877&worktree=issue-381'
    );
    expect(identity).toEqual({
      branchName: 'issue-381',
      headSha: 'a'.repeat(40),
      issueNumber: 381,
      machineId: 'os-mac',
      projectId: 'project-space',
      pullRequestNumber: 382,
      repositoryFullName: 'DotNaos/project-space',
      surface: 'mobile-prototype',
      threadId: '019fae8d-1eae-7282-9278-b57771a9c877',
      worktreeId: 'issue-381',
    });
  });

  test('fails closed when native launch identity is incomplete or targets web', () => {
    expect(nativePrototypeIdentityFromUrl('projectspace://prototype?pr=382'))
      .toBeUndefined();
    expect(nativePrototypeIdentityFromUrl(
      `projectspace://prototype?repository=DotNaos%2Fproject-space&pr=382` +
      `&project=project-space&head=${'a'.repeat(40)}&surface=web`
    )).toBeUndefined();
  });
});
