import { describe, expect, test } from 'bun:test';

import {
  finishIssueCreationWithAvailableImages,
  issueLabelsMatch,
  runIssueCreationWorkflow
} from '../src/features/project-desktop/components/issue-creation-workflow';
import type {
  GitHubIssueCreateRequest,
  GitHubIssueMutationResult,
  GitHubIssueRecord,
  GitHubIssueUpdateRequest
} from '../src/shared/project-space-api';

function issue(overrides: Partial<GitHubIssueRecord> = {}): GitHubIssueRecord {
  return {
    body: 'Description',
    labels: [],
    number: 187,
    state: 'open',
    title: 'Create issue modal',
    url: 'https://github.com/DotNaos/project-space/issues/187',
    ...overrides
  };
}

const request: GitHubIssueCreateRequest = {
  body: 'Description\n\n![Pasted image](project-space-attachment://one)',
  fullName: 'DotNaos/project-space',
  labels: ['bug'],
  operationId: '00000000-0000-4000-8000-000000000187',
  title: 'Create issue modal'
};

describe('issue creation workflow', () => {
  test('creates the issue before images, applies labels separately, and finalizes Markdown', async () => {
    const calls: string[] = [];
    const observed: GitHubIssueRecord[] = [];
    const updates: GitHubIssueUpdateRequest[] = [];

    const outcome = await runIssueCreationWorkflow({
      createIssue: async (createdRequest) => {
        calls.push('create');
        expect(createdRequest).toEqual({
          body: 'Description',
          fullName: request.fullName,
          operationId: request.operationId,
          title: request.title
        });
        return { creationState: 'complete', issue: issue(), status: 'connected' };
      },
      initialBody: 'Description',
      onRemoteIssue: (remoteIssue) => observed.push(remoteIssue),
      request,
      updateIssue: async (updateRequest) => {
        updates.push(updateRequest);
        if (updateRequest.labels) {
          calls.push('labels');
          return { issue: issue({ labels: ['bug'] }), status: 'connected' };
        }
        calls.push('body');
        return {
          issue: issue({
            body: 'Description\n\n![Pasted image](https://raw.githubusercontent.com/image.png)',
            labels: ['bug']
          }),
          status: 'connected'
        };
      },
      uploadAttachments: async (issueNumber) => {
        calls.push(`upload:${issueNumber}`);
        return {
          completed: true,
          markdown: 'Description\n\n![Pasted image](https://raw.githubusercontent.com/image.png)',
          persistableMarkdown:
            'Description\n\n![Pasted image](https://raw.githubusercontent.com/image.png)'
        };
      }
    });

    expect(calls).toEqual(['create', 'labels', 'upload:187', 'body']);
    expect(updates).toEqual([
      { fullName: request.fullName, labels: ['bug'], number: 187 },
      {
        body: 'Description\n\n![Pasted image](https://raw.githubusercontent.com/image.png)',
        fullName: request.fullName,
        number: 187
      }
    ]);
    expect(observed).toHaveLength(3);
    expect(outcome.status).toBe('complete');
  });

  test('retries setup against the known issue without creating a duplicate', async () => {
    let createCalls = 0;
    const knownIssue = issue({ labels: ['bug'] });

    const outcome = await runIssueCreationWorkflow({
      createIssue: async () => {
        createCalls += 1;
        return { creationState: 'retryable', status: 'error' };
      },
      existingIssue: knownIssue,
      initialBody: 'Description',
      onRemoteIssue: () => undefined,
      request,
      updateIssue: async ({ body }): Promise<GitHubIssueMutationResult> => ({
        issue: issue({ body, labels: ['bug'] }),
        status: 'connected'
      }),
      uploadAttachments: async () => ({
        completed: true,
        markdown: 'Description with stored image',
        persistableMarkdown: 'Description with stored image'
      })
    });

    expect(createCalls).toBe(0);
    expect(outcome.status).toBe('complete');
  });

  test('retains a created issue when attachment storage fails', async () => {
    const created = issue({ labels: ['bug'] });
    const outcome = await runIssueCreationWorkflow({
      createIssue: async () => ({
        creationState: 'complete',
        issue: created,
        status: 'connected'
      }),
      initialBody: 'Description',
      onRemoteIssue: () => undefined,
      request,
      updateIssue: async () => ({ issue: created, status: 'connected' }),
      uploadAttachments: async () => ({
        completed: false,
        markdown: request.body ?? '',
        persistableMarkdown: 'Description with the one stored image'
      })
    });

    expect(outcome).toEqual({
      error: 'The issue was created, but one or more pasted images could not be stored.',
      issue: created,
      recoveryBody: 'Description with the one stored image',
      stage: 'attachments',
      status: 'created-incomplete'
    });
  });

  test('continues storing images but reports labels GitHub silently omitted', async () => {
    const calls: string[] = [];
    const outcome = await runIssueCreationWorkflow({
      createIssue: async () => ({
        creationState: 'complete',
        issue: issue(),
        status: 'connected'
      }),
      initialBody: 'Description',
      onRemoteIssue: () => undefined,
      request,
      updateIssue: async (updateRequest) => {
        if (updateRequest.labels) {
          calls.push('labels');
          return { issue: issue(), status: 'connected' };
        }
        calls.push('body');
        return { issue: issue({ body: updateRequest.body }), status: 'connected' };
      },
      uploadAttachments: async () => {
        calls.push('images');
        return {
          completed: true,
          markdown: 'Description with image',
          persistableMarkdown: 'Description with image'
        };
      }
    });

    expect(calls).toEqual(['labels', 'images', 'body']);
    expect(outcome.status).toBe('created-incomplete');
    if (outcome.status === 'created-incomplete') {
      expect(outcome.stage).toBe('labels');
      expect(outcome.error).toContain('did not apply every selected label');
    }
  });

  test('does not retry an ambiguous failed create inside one workflow run', async () => {
    let createCalls = 0;
    const outcome = await runIssueCreationWorkflow({
      createIssue: async () => {
        createCalls += 1;
        throw new Error('Connection ended before GitHub replied.');
      },
      initialBody: 'Description',
      onRemoteIssue: () => undefined,
      request,
      updateIssue: async () => ({ status: 'error' }),
      uploadAttachments: async () => ({
        completed: true,
        markdown: 'Description',
        persistableMarkdown: 'Description'
      })
    });

    expect(createCalls).toBe(1);
    expect(outcome).toEqual({
      creationState: 'uncertain',
      error: 'Connection ended before GitHub replied.',
      status: 'creation-failed'
    });
  });

  test('preserves a definitive retry-safe creation failure', async () => {
    const outcome = await runIssueCreationWorkflow({
      createIssue: async () => ({
        creationState: 'retryable',
        message: 'GitHub rejected the issue.',
        status: 'error'
      }),
      initialBody: 'Description',
      onRemoteIssue: () => undefined,
      request,
      updateIssue: async () => ({ status: 'error' }),
      uploadAttachments: async () => ({
        completed: true,
        markdown: 'Description',
        persistableMarkdown: 'Description'
      })
    });

    expect(outcome).toEqual({
      creationState: 'retryable',
      error: 'GitHub rejected the issue.',
      status: 'creation-failed'
    });
  });

  test('finishes with only the Markdown for images already stored', async () => {
    const existing = issue({ body: 'Description' });
    const finalBody = 'Description\n\n![Pasted image](https://raw.githubusercontent.com/image.png)';
    const updates: GitHubIssueUpdateRequest[] = [];

    const outcome = await finishIssueCreationWithAvailableImages({
      body: finalBody,
      fullName: request.fullName,
      issue: existing,
      onRemoteIssue: () => undefined,
      updateIssue: async (updateRequest) => {
        updates.push(updateRequest);
        return { issue: issue({ body: finalBody }), status: 'connected' };
      }
    });

    expect(updates).toEqual([
      { body: finalBody, fullName: request.fullName, number: existing.number }
    ]);
    expect(outcome.status).toBe('complete');
  });

  test('compares label sets without case or ordering differences', () => {
    expect(issueLabelsMatch(['Bug', 'Needs Review'], ['needs review', 'bug'])).toBe(true);
    expect(issueLabelsMatch(['bug'], ['bug', 'enhancement'])).toBe(false);
  });
});
