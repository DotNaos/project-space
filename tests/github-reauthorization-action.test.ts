import { describe, expect, test } from 'bun:test';

import { getGitHubReauthorizationAction } from '../src/features/project-desktop/components/github-reauthorization-action';

describe('GitHub reauthorization action', () => {
  test('hides the duplicate action when an embedded login code is visible', () => {
    expect(getGitHubReauthorizationAction({
      embedded: true,
      flowPending: true
    })).toBeUndefined();
  });

  test('uses a primary action before the login code is available', () => {
    expect(getGitHubReauthorizationAction({
      embedded: true,
      flowPending: false
    })).toEqual({
      label: 'Reconnect GitHub',
      variant: 'primary'
    });
  });

  test('keeps a low-emphasis reopen action for the standalone modal', () => {
    expect(getGitHubReauthorizationAction({
      embedded: false,
      flowPending: true
    })).toEqual({
      label: 'Continue GitHub login',
      variant: 'ghost'
    });
  });
});
