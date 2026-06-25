import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createGithubIdeaFromDraft,
  listGithubIdeas,
  updateGithubIdea
} from './github-ideas';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: {
      'Content-Type': 'application/json'
    },
    status
  });
}

test('listGithubIdeas loads issues from the GitHub API and filters pull requests', async () => {
  const calls: Array<{ url: string; method: string }> = [];

  const ideas = await listGithubIdeas(
    {
      includeClosed: false,
      projectPath: '/tmp/project'
    },
    {
      fetchImpl: async (input, init) => {
        const url = String(input);

        calls.push({
          method: init?.method ?? 'GET',
          url
        });

        assert.match(url, /https:\/\/api\.github\.com\/repos\/acme\/widget\/issues\?/);
        assert.equal(
          (init?.headers as Record<string, string>).Authorization,
          'Bearer token-123'
        );

        return jsonResponse([
          {
            body: 'Issue body',
            created_at: '2026-04-01T10:00:00.000Z',
            labels: [{ name: 'iteration:sprint-1' }],
            number: 42,
            state: 'open',
            title: 'Ship OAuth',
            updated_at: '2026-04-02T10:00:00.000Z',
            html_url: 'https://github.com/acme/widget/issues/42'
          },
          {
            body: 'Ignore this pull request',
            created_at: '2026-04-01T09:00:00.000Z',
            labels: [],
            number: 7,
            pull_request: {
              url: 'https://api.github.com/repos/acme/widget/pulls/7'
            },
            state: 'open',
            title: 'A pull request',
            updated_at: '2026-04-02T09:00:00.000Z',
            html_url: 'https://github.com/acme/widget/pull/7'
          }
        ]);
      },
      loadAuthSession: () =>
        Promise.resolve({
          accessToken: 'token-123',
          viewer: {
            avatarUrl: 'https://avatars.githubusercontent.com/u/1',
            login: 'oli',
            name: 'Oli'
          }
        }),
      loadProjectIssueSourceConfig: () =>
        Promise.resolve({
          kind: 'github',
          source: 'saved',
          url: 'https://github.com/acme/widget'
        })
    }
  );

  assert.equal(calls.length, 1);
  assert.equal(ideas.length, 1);
  assert.equal(ideas[0]?.githubIssueNumber, 42);
  assert.equal(ideas[0]?.iteration, 'sprint-1');
  assert.equal(ideas[0]?.title, 'Ship OAuth');
});

test('createGithubIdeaFromDraft creates an issue through the GitHub API', async () => {
  const calls: Array<{ body?: string; method: string; url: string }> = [];

  const result = await createGithubIdeaFromDraft(
    {
      draft: {
        body: 'Use OAuth instead of gh',
        createdAt: '2026-04-03T10:00:00.000Z',
        id: 'idea-123',
        iteration: 'sprint-2',
        source: 'local',
        title: 'Replace gh',
        updatedAt: '2026-04-03T10:00:00.000Z'
      },
      projectPath: '/tmp/project'
    },
    {
      fetchImpl: async (input, init) => {
        const url = String(input);

        calls.push({
          body: typeof init?.body === 'string' ? init.body : undefined,
          method: init?.method ?? 'GET',
          url
        });

        if (url.endsWith('/labels') && (init?.method ?? 'GET') === 'POST') {
          return jsonResponse(
            {
              color: '4F46E5',
              name: 'iteration:sprint-2'
            },
            201
          );
        }

        if (url.endsWith('/issues') && (init?.method ?? 'GET') === 'POST') {
          return jsonResponse(
            {
              body: 'Use OAuth instead of gh\n\n<!-- project-space-idea-meta\n{"evolvesIdeaId":null,"id":"idea-123"}\n-->',
              created_at: '2026-04-03T10:00:00.000Z',
              labels: [{ name: 'iteration:sprint-2' }],
              number: 99,
              state: 'open',
              title: 'Replace gh',
              updated_at: '2026-04-03T10:00:00.000Z',
              html_url: 'https://github.com/acme/widget/issues/99'
            },
            201
          );
        }

        throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url}`);
      },
      loadAuthSession: () =>
        Promise.resolve({
          accessToken: 'token-123',
          viewer: {
            avatarUrl: 'https://avatars.githubusercontent.com/u/1',
            login: 'oli',
            name: 'Oli'
          }
        }),
      loadProjectIssueSourceConfig: () =>
        Promise.resolve({
          kind: 'github',
          source: 'saved',
          url: 'https://github.com/acme/widget'
        })
    }
  );

  assert.equal(result.status, 'success');
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.method, 'POST');
  assert.match(calls[0]?.url ?? '', /\/repos\/acme\/widget\/labels$/);
  assert.equal(calls[1]?.method, 'POST');
  assert.match(calls[1]?.url ?? '', /\/repos\/acme\/widget\/issues$/);
  assert.match(calls[1]?.body ?? '', /Replace gh/);
  assert.match(calls[1]?.body ?? '', /iteration:sprint-2/);
});

test('updateGithubIdea patches the issue with labels and state through the GitHub API', async () => {
  const calls: Array<{ body?: string; method: string; url: string }> = [];

  const result = await updateGithubIdea(
    {
      idea: {
        body: 'Updated body',
        createdAt: '2026-04-03T10:00:00.000Z',
        githubIssueNumber: 99,
        githubIssueUrl: 'https://github.com/acme/widget/issues/99',
        githubLabels: ['iteration:sprint-1', 'ux'],
        githubState: 'closed',
        id: 'idea-123',
        iteration: 'sprint-2',
        source: 'github',
        title: 'Replace gh',
        updatedAt: '2026-04-04T10:00:00.000Z'
      },
      projectPath: '/tmp/project'
    },
    {
      fetchImpl: async (input, init) => {
        const url = String(input);

        calls.push({
          body: typeof init?.body === 'string' ? init.body : undefined,
          method: init?.method ?? 'GET',
          url
        });

        if (url.endsWith('/labels') && (init?.method ?? 'GET') === 'POST') {
          return jsonResponse(
            {
              color: '4F46E5',
              name: 'iteration:sprint-2'
            },
            201
          );
        }

        if (url.endsWith('/issues/99') && (init?.method ?? 'GET') === 'PATCH') {
          return jsonResponse({
            body: 'Updated body\n\n<!-- project-space-idea-meta\n{"evolvesIdeaId":null,"id":"idea-123"}\n-->',
            created_at: '2026-04-03T10:00:00.000Z',
            labels: [{ name: 'iteration:sprint-2' }, { name: 'ux' }],
            number: 99,
            state: 'closed',
            title: 'Replace gh',
            updated_at: '2026-04-04T10:00:00.000Z',
            html_url: 'https://github.com/acme/widget/issues/99'
          });
        }

        throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url}`);
      },
      loadAuthSession: () =>
        Promise.resolve({
          accessToken: 'token-123',
          viewer: {
            avatarUrl: 'https://avatars.githubusercontent.com/u/1',
            login: 'oli',
            name: 'Oli'
          }
        }),
      loadProjectIssueSourceConfig: () =>
        Promise.resolve({
          kind: 'github',
          source: 'saved',
          url: 'https://github.com/acme/widget'
        })
    }
  );

  assert.equal(result.status, 'success');
  assert.equal(calls.length, 2);
  assert.match(calls[1]?.url ?? '', /\/repos\/acme\/widget\/issues\/99$/);
  assert.equal(calls[1]?.method, 'PATCH');
  assert.match(calls[1]?.body ?? '', /"state":"closed"/);
  assert.match(calls[1]?.body ?? '', /"iteration:sprint-2"/);
  assert.doesNotMatch(calls[1]?.body ?? '', /iteration:sprint-1/);
});
