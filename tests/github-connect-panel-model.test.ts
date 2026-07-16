import { describe, expect, test } from 'bun:test';

import { getGitHubConnectPanelPresentation } from '../src/features/project-desktop/components/github-connect-panel-model';
import type { GitHubCatalogResult } from '../src/shared/project-space-api';

const catalog: GitHubCatalogResult = {
  checkedAt: '2026-07-16T00:00:00.000Z',
  repositories: [],
  status: 'auth-required'
};

describe('GitHub connect panel presentation', () => {
  test('keeps an active device login behind a compact continue action', () => {
    const presentation = getGitHubConnectPanelPresentation({
      flow: {
        status: 'pending',
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://github.com/login/device'
      },
      githubCatalog: catalog,
      isConnecting: false
    });

    expect(presentation.primaryActionLabel).toBe('Continue GitHub login');
    expect(presentation.isPending).toBe(true);
    expect(presentation.description).toBe(
      'Connect GitHub to load repositories and projects.'
    );
  });

  test('turns catalog failures into a retry state', () => {
    const presentation = getGitHubConnectPanelPresentation({
      githubCatalog: {
        ...catalog,
        message: 'GitHub could not be reached.',
        status: 'error'
      },
      isConnecting: false
    });

    expect(presentation.title).toBe('Project catalog unavailable');
    expect(presentation.description).toBe(
      'The project catalog could not be loaded.'
    );
    expect(presentation.isLoadError).toBe(true);
  });

  test('disables login while GitHub OAuth is not configured', () => {
    const presentation = getGitHubConnectPanelPresentation({
      githubCatalog: {
        ...catalog,
        status: 'not-configured'
      },
      isConnecting: false
    });

    expect(presentation.primaryActionDisabled).toBe(true);
    expect(presentation.primaryActionLabel).toBe('Login with GitHub');
  });
});
