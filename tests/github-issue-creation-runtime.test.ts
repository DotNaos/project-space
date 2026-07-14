import { afterEach, describe, expect, test } from 'bun:test';

import { createProjectSpaceServer } from '../server/project-space-http';
import type { ProjectChatRuntime } from '../server/project-chat/runtime';
import type { GitHubIssueCreateRequest, ProjectSpaceBackend } from '../src/shared/project-space-api';

const originalAuthDisabled = process.env.PROJECT_SPACE_AUTH_DISABLED;

afterEach(() => {
  if (originalAuthDisabled === undefined) delete process.env.PROJECT_SPACE_AUTH_DISABLED;
  else process.env.PROJECT_SPACE_AUTH_DISABLED = originalAuthDisabled;
});

const quietProjectChat: ProjectChatRuntime = {
  async handleRequest() { return false; },
  start() {},
  stop() {}
};

function backend(onCreate: (request: GitHubIssueCreateRequest) => void = () => undefined) {
  return {
    async createGitHubIssue(request: GitHubIssueCreateRequest) {
      onCreate(request);
      return {
        creationState: 'complete' as const,
        issue: {
          body: request.body,
          labels: [],
          number: 187,
          state: 'open' as const,
          title: request.title,
          url: 'https://github.com/DotNaos/project-space/issues/187'
        },
        status: 'connected' as const
      };
    }
  } as ProjectSpaceBackend;
}

describe('GitHub issue creation runtime registration', () => {
  test('mounts metadata, upload, and private image validation after authentication', async () => {
    process.env.PROJECT_SPACE_AUTH_DISABLED = '1';
    const server = await createProjectSpaceServer({
      backend: backend(), host: '127.0.0.1', port: 0, projectChatRuntime: quietProjectChat
    });
    try {
      const responses = await Promise.all([
        fetch(`${server.origin}/api/github/issue-metadata`),
        fetch(`${server.origin}/api/github/issue-attachments`, { method: 'POST' }),
        fetch(`${server.origin}/api/github/issue-attachment-content`)
      ]);
      expect(responses.map(({ status }) => status)).toEqual([400, 400, 400]);
    } finally {
      await server.close();
    }
  });

  test('rejects focused endpoints before parsing without a browser session', async () => {
    delete process.env.PROJECT_SPACE_AUTH_DISABLED;
    const server = await createProjectSpaceServer({
      backend: backend(), host: '127.0.0.1', port: 0, projectChatRuntime: quietProjectChat
    });
    try {
      const responses = await Promise.all([
        fetch(`${server.origin}/api/github/issue-metadata`),
        fetch(`${server.origin}/api/github/issue-attachments`, {
          body: new Uint8Array([1, 2, 3]), method: 'POST'
        }),
        fetch(`${server.origin}/api/github/issue-attachment-content`)
      ]);
      expect(responses.map(({ status }) => status)).toEqual([401, 401, 401]);
      expect(await responses[1].json()).toEqual({ error: 'Login required.' });
    } finally {
      await server.close();
    }
  });

  test('leaves the existing issue mutation route on the shared backend', async () => {
    process.env.PROJECT_SPACE_AUTH_DISABLED = '1';
    const calls: GitHubIssueCreateRequest[] = [];
    const server = await createProjectSpaceServer({
      backend: backend((request) => calls.push(request)),
      host: '127.0.0.1', port: 0, projectChatRuntime: quietProjectChat
    });
    const request = {
      body: 'Description', fullName: 'DotNaos/project-space',
      operationId: '00000000-0000-4000-8000-000000000187', title: 'Create issue modal'
    };
    try {
      const response = await fetch(`${server.origin}/api/github/issues`, {
        body: JSON.stringify(request), headers: { 'Content-Type': 'application/json' }, method: 'POST'
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ issue: { number: 187 } });
      expect(calls).toEqual([request]);
    } finally {
      await server.close();
    }
  });
});
