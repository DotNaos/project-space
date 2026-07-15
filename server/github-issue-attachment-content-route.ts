import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  loadLocalGitHubIssueAttachmentContent,
  type LocalGitHubIssueAttachmentContentResult
} from './local-github-issue-attachment-content';
import {
  projectSpaceCorsHeaders,
  writeJson
} from './project-space-http-response';
import {
  GITHUB_ISSUE_ATTACHMENT_CONTENT_PATH,
  parseGitHubIssueAttachmentContentSearch,
  type GitHubIssueAttachmentLocation
} from '../src/shared/github-issue-attachment-location';

interface GitHubIssueAttachmentContentRouteOptions {
  loadAttachment?(
    location: GitHubIssueAttachmentLocation
  ): Promise<LocalGitHubIssueAttachmentContentResult>;
}

function setPrivateImageHeaders(response: ServerResponse) {
  const corsHeaders = projectSpaceCorsHeaders();
  response.setHeader('Cache-Control', 'private, no-store');
  response.setHeader(
    'Cross-Origin-Resource-Policy',
    'Access-Control-Allow-Origin' in corsHeaders ? 'cross-origin' : 'same-origin'
  );
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
}

export function createGitHubIssueAttachmentContentRoute(
  options: GitHubIssueAttachmentContentRouteOptions = {}
) {
  const loadAttachment =
    options.loadAttachment ?? loadLocalGitHubIssueAttachmentContent;

  return async function handleGitHubIssueAttachmentContentRoute(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL
  ) {
    if (
      request.method !== 'GET'
      || url.pathname !== GITHUB_ISSUE_ATTACHMENT_CONTENT_PATH
    ) {
      return false;
    }

    setPrivateImageHeaders(response);
    const location = parseGitHubIssueAttachmentContentSearch(url.searchParams);
    if (!location) {
      writeJson(response, 400, { error: 'Invalid issue image request.' });
      return true;
    }

    const result = await loadAttachment(location);
    if (result.status !== 'connected') {
      const statusCode = result.status === 'auth-required'
        ? 401
        : result.status === 'not-configured'
          ? 503
          : 404;
      writeJson(response, statusCode, { error: result.message });
      return true;
    }

    const corsHeaders = projectSpaceCorsHeaders();
    response.writeHead(200, {
      ...corsHeaders,
      'Cache-Control': 'private, no-store',
      'Content-Length': String(result.sizeBytes),
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Content-Type': result.mediaType,
      'Cross-Origin-Resource-Policy':
        'Access-Control-Allow-Origin' in corsHeaders ? 'cross-origin' : 'same-origin',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff'
    });
    response.end(Buffer.from(result.bytes));
    return true;
  };
}
