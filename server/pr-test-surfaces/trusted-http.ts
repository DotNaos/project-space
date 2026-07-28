import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ProjectSpaceBackend } from '../../src/shared/project-space-api';
import type { PullRequestPrototypeFeedbackRequest } from '../../src/shared/pr-preview-test-surfaces-api';
import { readJson, writeJson } from '../project-space-http-response';
import {
  PullRequestFeedbackUnavailableError,
  readConfiguredPullRequestTestSurfaces,
  sendConfiguredPullRequestPrototypeFeedback
} from './configured-runtime';

export function createPullRequestTestSurfacesTrustedRoute(backend: ProjectSpaceBackend) {
  return async function handlePullRequestTestSurfacesTrustedRoute(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    userId: string
  ) {
    const isRead = request.method === 'GET' &&
      url.pathname === '/api/pull-request-previews/test-surfaces';
    const isFeedback = request.method === 'POST' &&
      url.pathname === '/api/pull-request-previews/feedback';
    if (!isRead && !isFeedback) {
      return false;
    }
    if (isFeedback) {
      response.setHeader('Cache-Control', 'private, no-store');
      try {
        writeJson(response, 200, await sendConfiguredPullRequestPrototypeFeedback({
          backend,
          feedback: await readJson<PullRequestPrototypeFeedbackRequest>(request),
          userId
        }));
      } catch (error) {
        if (error instanceof PullRequestFeedbackUnavailableError) {
          writeJson(response, 409, { error: error.message });
        } else if (error instanceof TypeError) {
          writeJson(response, 400, { error: error.message });
        } else {
          throw error;
        }
      }
      return true;
    }
    const repositories = url.searchParams.getAll('repositoryFullName');
    const pullRequests = url.searchParams.getAll('pullRequestNumber');
    const hasUnknown = [...url.searchParams.keys()].some(
      (key) => key !== 'repositoryFullName' && key !== 'pullRequestNumber'
    );
    const pullRequestNumber = Number(pullRequests[0]);
    if (
      repositories.length !== 1 ||
      pullRequests.length !== 1 ||
      hasUnknown ||
      !repositories[0] ||
      !Number.isSafeInteger(pullRequestNumber) ||
      pullRequestNumber < 1
    ) {
      writeJson(response, 400, {
        error: 'Missing or invalid repositoryFullName or pullRequestNumber.'
      });
      return true;
    }
    response.setHeader('Cache-Control', 'private, no-store');
    writeJson(response, 200, await readConfiguredPullRequestTestSurfaces({
      backend,
      pullRequestNumber,
      repositoryFullName: repositories[0],
      userId
    }));
    return true;
  };
}
