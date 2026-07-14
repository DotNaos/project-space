import type { IncomingMessage, ServerResponse } from 'node:http';

import type { GitHubRepositorySummaryResult } from '../src/shared/github-repository-summary';
import { loadLocalGitHubRepositorySummary } from './local-github-repository-summary';
import { writeJson } from './project-space-http-response';

interface GitHubRepositorySummaryRouteOptions {
  loadSummary?(fullName: string): Promise<GitHubRepositorySummaryResult>;
}

function hasOnlyFullName(searchParams: URLSearchParams) {
  const keys = Array.from(searchParams.keys());
  return keys.length === 1 && keys[0] === 'fullName';
}

export function createGitHubRepositorySummaryRoute(
  options: GitHubRepositorySummaryRouteOptions = {}
) {
  const loadSummary = options.loadSummary ?? loadLocalGitHubRepositorySummary;

  return async function handleGitHubRepositorySummaryRoute(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL
  ) {
    if (request.method !== 'GET' || url.pathname !== '/api/github/repository-summary') {
      return false;
    }

    const fullName = url.searchParams.get('fullName');
    if (!fullName || !hasOnlyFullName(url.searchParams)) {
      writeJson(response, 400, { error: 'Invalid repository summary request.' });
      return true;
    }

    response.setHeader('Cache-Control', 'private, no-store');
    writeJson(response, 200, await loadSummary(fullName));
    return true;
  };
}
