import { describe, expect, test } from 'bun:test';

import { pullRequestPreviewAppHref } from '../src/shared/pull-request-preview-link';

describe('pull request Preview app link', () => {
  test('routes the exact app path through the trusted hub', () => {
    expect(pullRequestPreviewAppHref(
      439,
      '/projects/project-space/issues/437'
    )).toBe(
      'https://pr.projects.os-home.net/?pr=439&return=%2Fprojects%2Fproject-space%2Fissues%2F437'
    );
  });

  test('rejects unsafe or invalid targets', () => {
    expect(pullRequestPreviewAppHref(0, '/projects')).toBeUndefined();
    expect(pullRequestPreviewAppHref(439, '//attacker.example')).toBeUndefined();
    expect(pullRequestPreviewAppHref(439, '/projects\nredirect')).toBeUndefined();
  });
});
