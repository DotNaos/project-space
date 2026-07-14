import { describe, expect, test } from 'bun:test';

import {
  GITHUB_ISSUE_ATTACHMENT_MAX_BYTES,
  createInitialIssueAttachmentState,
  hasUnresolvedIssueAttachments,
  issueAttachmentMarkdown,
  issueAttachmentMarkdownWithUploadedAttachments,
  issueAttachmentMarkdownWithoutAttachments,
  issueAttachmentPlaceholder,
  issueAttachmentReducer,
  mayHaveReachedRemote,
  projectSpaceIssueAttachmentUrls,
  validateIssueAttachmentCandidate,
  type IssueAttachmentAction,
  type IssueAttachmentState
} from '../src/features/project-desktop/components/issue-attachment-model';

const REPOSITORY = 'DotNaos/project-space';
const ATTACHMENT_ID = '00000000-0000-4000-8000-000000000001';
const ISSUE_NUMBER = 187;

function storedImageUrl(
  attachmentId = ATTACHMENT_ID,
  extension: 'gif' | 'jpg' | 'png' = 'png',
  repository = REPOSITORY
) {
  return `https://github.com/${repository}/blob/${'a'.repeat(40)}/.github/project-space/issue-attachments/${ISSUE_NUMBER}/${attachmentId}.${extension}?raw=1`;
}

function reduce(state: IssueAttachmentState, ...actions: IssueAttachmentAction[]) {
  return actions.reduce(issueAttachmentReducer, state);
}

function queue(
  state: IssueAttachmentState,
  {
    attachmentId = ATTACHMENT_ID,
    cursor = state.markdown.length,
    mediaType = 'image/png' as const,
    sizeBytes = 128
  } = {}
) {
  return issueAttachmentReducer(state, {
    attachmentId,
    cursor,
    mediaType,
    repositoryKey: REPOSITORY,
    sizeBytes,
    type: 'attachment-queued'
  });
}

describe('issue attachment candidates', () => {
  test('treats a started upload as potentially remote even when it later fails', () => {
    let state = queue(createInitialIssueAttachmentState({ repositoryKey: REPOSITORY }));
    expect(mayHaveReachedRemote(state.attachments[0])).toBe(false);

    state = reduce(state, {
      attachmentId: ATTACHMENT_ID,
      repositoryKey: REPOSITORY,
      requestId: 'upload-1',
      type: 'upload-started'
    });
    expect(mayHaveReachedRemote(state.attachments[0])).toBe(true);

    state = reduce(state, {
      attachmentId: ATTACHMENT_ID,
      error: 'The upload response was lost.',
      repositoryKey: REPOSITORY,
      requestId: 'upload-1',
      type: 'upload-failed'
    });
    expect(state.attachments[0].status).toBe('failed');
    expect(mayHaveReachedRemote(state.attachments[0])).toBe(true);
  });

  test('finds only exact Project Space attachment URLs for the current repository', () => {
    const valid = storedImageUrl();
    const otherRepository = valid.replace(REPOSITORY, 'DotNaos/other');
    const markdown = [
      `![Stored](${valid})`,
      `![Duplicate](${valid})`,
      `![Other repository](${otherRepository})`,
      '![External](https://github.com/DotNaos/project-space/raw/main/image.png)'
    ].join('\n');

    expect(projectSpaceIssueAttachmentUrls(markdown, REPOSITORY)).toEqual([valid]);
    expect(projectSpaceIssueAttachmentUrls(markdown, null)).toEqual([]);
  });

  test('accepts only non-empty PNG, JPEG, and GIF candidates up to 10 MiB', () => {
    expect(validateIssueAttachmentCandidate({ mediaType: 'image/png', sizeBytes: 1 })).toEqual({
      mediaType: 'image/png',
      sizeBytes: 1
    });
    expect(
      validateIssueAttachmentCandidate({
        mediaType: 'image/jpeg',
        sizeBytes: GITHUB_ISSUE_ATTACHMENT_MAX_BYTES
      })
    ).toEqual({
      mediaType: 'image/jpeg',
      sizeBytes: GITHUB_ISSUE_ATTACHMENT_MAX_BYTES
    });
    expect(validateIssueAttachmentCandidate({ mediaType: 'image/gif', sizeBytes: 42 })).toEqual({
      mediaType: 'image/gif',
      sizeBytes: 42
    });

    expect(() =>
      validateIssueAttachmentCandidate({ mediaType: 'image/svg+xml', sizeBytes: 100 })
    ).toThrow('Paste a PNG, JPEG, or non-animated GIF image.');
    expect(() =>
      validateIssueAttachmentCandidate({ mediaType: 'image/webp', sizeBytes: 100 })
    ).toThrow('Paste a PNG, JPEG, or non-animated GIF image.');
    expect(() =>
      validateIssueAttachmentCandidate({ mediaType: 'image/png', sizeBytes: 0 })
    ).toThrow('The pasted image is empty.');
    expect(() =>
      validateIssueAttachmentCandidate({
        mediaType: 'image/png',
        sizeBytes: GITHUB_ISSUE_ATTACHMENT_MAX_BYTES + 1
      })
    ).toThrow('Pasted images must be 10 MiB or smaller.');
  });
});

describe('issue attachment draft state', () => {
  test('inserts a generic placeholder at the exact cursor without exposing the filename', () => {
    const original = createInitialIssueAttachmentState({
      markdown: 'BeforeAfter',
      repositoryKey: REPOSITORY
    });
    const state = issueAttachmentReducer(original, {
      attachmentId: 'paste-a',
      cursor: 6,
      mediaType: 'image/png',
      originalName: '](javascript:alert(1)).png',
      repositoryKey: REPOSITORY,
      sizeBytes: 320,
      type: 'attachment-queued'
    });

    const placeholder = issueAttachmentPlaceholder('paste-a');
    expect(state.markdown).toBe(`Before${placeholder}After`);
    expect(state.markdown).not.toContain('javascript');
    expect(state.attachments).toEqual([
      {
        attachmentId: 'paste-a',
        mediaType: 'image/png',
        repositoryKey: REPOSITORY,
        requestId: null,
        sizeBytes: 320,
        status: 'queued'
      }
    ]);
    expect(hasUnresolvedIssueAttachments(state)).toBe(true);
  });

  test('replaces only its exact placeholder when the current upload succeeds', () => {
    const queued = queue(
      createInitialIssueAttachmentState({
        markdown: 'Start ',
        repositoryKey: REPOSITORY
      })
    );
    const uploading = issueAttachmentReducer(queued, {
      attachmentId: ATTACHMENT_ID,
      repositoryKey: REPOSITORY,
      requestId: 'upload-1',
      type: 'upload-started'
    });
    const completed = issueAttachmentReducer(uploading, {
      attachmentId: ATTACHMENT_ID,
      markdownUrl: storedImageUrl(),
      repositoryKey: REPOSITORY,
      requestId: 'upload-1',
      type: 'upload-succeeded'
    });

    expect(completed.markdown).toBe(
      `Start ${issueAttachmentMarkdown(
        storedImageUrl()
      )}`
    );
    expect(completed.attachments[0]).toMatchObject({
      markdownUrl: storedImageUrl(),
      renderedMarkdown: issueAttachmentMarkdown(
        storedImageUrl()
      ),
      requestId: 'upload-1',
      status: 'uploaded'
    });
    expect(hasUnresolvedIssueAttachments(completed)).toBe(false);
  });

  test('keeps retryable failures and accepts a later request', () => {
    let state = queue(createInitialIssueAttachmentState({ repositoryKey: REPOSITORY }));
    state = reduce(
      state,
      {
        attachmentId: ATTACHMENT_ID,
        repositoryKey: REPOSITORY,
        requestId: 'upload-1',
        type: 'upload-started'
      },
      {
        attachmentId: ATTACHMENT_ID,
        error: 'GitHub could not store this image.',
        repositoryKey: REPOSITORY,
        requestId: 'upload-1',
        type: 'upload-failed'
      }
    );

    expect(state.attachments[0]).toMatchObject({
      error: 'GitHub could not store this image.',
      requestId: 'upload-1',
      status: 'failed'
    });
    expect(state.markdown).toContain(issueAttachmentPlaceholder(ATTACHMENT_ID));
    expect(hasUnresolvedIssueAttachments(state)).toBe(true);

    state = reduce(
      state,
      {
        attachmentId: ATTACHMENT_ID,
        repositoryKey: REPOSITORY,
        requestId: 'upload-2',
        type: 'upload-started'
      },
      {
        attachmentId: ATTACHMENT_ID,
        markdownUrl: storedImageUrl(),
        repositoryKey: REPOSITORY,
        requestId: 'upload-2',
        type: 'upload-succeeded'
      }
    );

    expect(state.attachments[0].status).toBe('uploaded');
    expect(state.markdown).toBe(
      issueAttachmentMarkdown(storedImageUrl())
    );
    expect(hasUnresolvedIssueAttachments(state)).toBe(false);
  });

  test('ignores stale upload failures and successes', () => {
    let state = queue(createInitialIssueAttachmentState({ repositoryKey: REPOSITORY }));
    state = reduce(
      state,
      {
        attachmentId: ATTACHMENT_ID,
        repositoryKey: REPOSITORY,
        requestId: 'upload-old',
        type: 'upload-started'
      },
      {
        attachmentId: ATTACHMENT_ID,
        repositoryKey: REPOSITORY,
        requestId: 'upload-new',
        type: 'upload-started'
      }
    );
    const current = state;

    state = reduce(
      state,
      {
        attachmentId: ATTACHMENT_ID,
        error: 'Stale failure',
        repositoryKey: REPOSITORY,
        requestId: 'upload-old',
        type: 'upload-failed'
      },
      {
        attachmentId: ATTACHMENT_ID,
        markdownUrl: storedImageUrl(),
        repositoryKey: REPOSITORY,
        requestId: 'upload-old',
        type: 'upload-succeeded'
      }
    );

    expect(state).toBe(current);
    expect(state.markdown).toContain(issueAttachmentPlaceholder(ATTACHMENT_ID));
  });

  test('removes the matching placeholder and makes in-flight completions harmless', () => {
    let state = queue(
      createInitialIssueAttachmentState({
        markdown: 'Before  After',
        repositoryKey: REPOSITORY
      }),
      { cursor: 7 }
    );
    state = issueAttachmentReducer(state, {
      attachmentId: ATTACHMENT_ID,
      repositoryKey: REPOSITORY,
      requestId: 'upload-1',
      type: 'upload-started'
    });
    state = issueAttachmentReducer(state, {
      attachmentId: ATTACHMENT_ID,
      type: 'attachment-removed'
    });

    expect(state.attachments).toEqual([]);
    expect(state.markdown).toBe('Before  After');
    expect(hasUnresolvedIssueAttachments(state)).toBe(false);

    const afterLateSuccess = issueAttachmentReducer(state, {
      attachmentId: ATTACHMENT_ID,
      markdownUrl: 'https://github.com/user-attachments/assets/late-id',
      repositoryKey: REPOSITORY,
      requestId: 'upload-1',
      type: 'upload-succeeded'
    });
    expect(afterLateSuccess).toBe(state);
  });

  test('treats deleting attachment Markdown from the editor as removing the attachment', () => {
    let state = queue(createInitialIssueAttachmentState({ repositoryKey: REPOSITORY }));
    state = issueAttachmentReducer(state, { markdown: '', type: 'markdown-changed' });

    expect(state.attachments).toEqual([]);
    expect(hasUnresolvedIssueAttachments(state)).toBe(false);
    expect(
      issueAttachmentReducer(state, {
        attachmentId: ATTACHMENT_ID,
        markdownUrl: 'https://github.com/user-attachments/assets/late-id',
        repositoryKey: REPOSITORY,
        requestId: 'upload-1',
        type: 'upload-succeeded'
      })
    ).toBe(state);
  });

  test('keeps tracking an attachment when only its alt text changes', () => {
    const attachmentId = '00000000-0000-4000-8000-000000000001';
    const requestId = '00000000-0000-4000-8000-000000000002';
    const markdownUrl =
      `https://github.com/DotNaos/project-space/blob/${'a'.repeat(40)}/` +
      `.github/project-space/issue-attachments/${ISSUE_NUMBER}/${attachmentId}.png?raw=1`;
    let state = queue(
      createInitialIssueAttachmentState({ repositoryKey: REPOSITORY }),
      { attachmentId }
    );
    state = reduce(
      state,
      {
        attachmentId,
        repositoryKey: 'DotNaos/project-space',
        requestId,
        type: 'upload-started'
      },
      {
        attachmentId,
        markdownUrl,
        repositoryKey: 'DotNaos/project-space',
        requestId,
        type: 'upload-succeeded'
      },
      {
        markdown: `Before\n\n![A clearer description](${markdownUrl})\n\nAfter`,
        type: 'markdown-changed'
      }
    );

    expect(state.attachments).toHaveLength(1);
    state = issueAttachmentReducer(state, {
      repositoryKey: 'DotNaos/another-repository',
      type: 'repository-changed'
    });
    expect(state.attachments).toEqual([]);
    expect(state.markdown).toBe('Before\n\n\n\nAfter');
  });

  test('uploads and removes a pending image even after its alt text changes', () => {
    const attachmentId = '00000000-0000-4000-8000-000000000001';
    const requestId = '00000000-0000-4000-8000-000000000002';
    const markdownUrl =
      `https://github.com/DotNaos/project-space/blob/${'b'.repeat(40)}/` +
      `.github/project-space/issue-attachments/${ISSUE_NUMBER}/${attachmentId}.png?raw=1`;
    let state = queue(
      createInitialIssueAttachmentState({ repositoryKey: REPOSITORY }),
      { attachmentId }
    );
    state = reduce(
      state,
      {
        markdown: state.markdown.replace('Pasted image uploading', 'Screenshot of the bug'),
        type: 'markdown-changed'
      },
      {
        attachmentId,
        repositoryKey: 'DotNaos/project-space',
        requestId,
        type: 'upload-started'
      },
      {
        attachmentId,
        markdownUrl,
        repositoryKey: 'DotNaos/project-space',
        requestId,
        type: 'upload-succeeded'
      }
    );

    expect(state.attachments).toHaveLength(1);
    expect(state.markdown).toContain(`![Pasted image](${markdownUrl})`);
    expect(state.markdown).not.toContain('project-space-attachment://');
  });

  test('rejects a current success URL outside GitHub-owned image hosts', () => {
    let state = queue(createInitialIssueAttachmentState({ repositoryKey: REPOSITORY }));
    state = issueAttachmentReducer(state, {
      attachmentId: ATTACHMENT_ID,
      repositoryKey: REPOSITORY,
      requestId: 'upload-1',
      type: 'upload-started'
    });
    const uploading = state;

    state = issueAttachmentReducer(state, {
      attachmentId: ATTACHMENT_ID,
      markdownUrl: 'https://attacker.example/image.png',
      repositoryKey: REPOSITORY,
      requestId: 'upload-1',
      type: 'upload-succeeded'
    });

    expect(state).toBe(uploading);
    expect(() => issueAttachmentMarkdown('https://attacker.example/image.png')).toThrow(
      'The uploaded image URL is invalid.'
    );
    expect(hasUnresolvedIssueAttachments(state)).toBe(true);
  });

  test('keeps ordinary Markdown but removes repository-specific placeholders on switch', () => {
    let state = createInitialIssueAttachmentState({
      markdown: 'Intro\n',
      repositoryKey: REPOSITORY
    });
    state = queue(state, { attachmentId: 'first' });
    state = queue(state, { attachmentId: 'second' });
    state = issueAttachmentReducer(state, {
      repositoryKey: 'DotNaos/another-repository',
      type: 'repository-changed'
    });

    expect(state.repositoryKey).toBe('DotNaos/another-repository');
    expect(state.attachments).toEqual([]);
    expect(state.markdown).toBe('Intro\n');
    expect(hasUnresolvedIssueAttachments(state)).toBe(false);
  });

  test('removes exact uploaded image Markdown when its repository changes', () => {
    const imageUrl = storedImageUrl();
    const renderedImage = issueAttachmentMarkdown(imageUrl);
    const unrelatedImage =
      '![Pasted image](https://github.com/user-attachments/assets/unrelated-image)';
    let state = queue(
      createInitialIssueAttachmentState({
        markdown: `Intro\n${unrelatedImage}\n`,
        repositoryKey: REPOSITORY
      })
    );
    state = reduce(
      state,
      {
        attachmentId: ATTACHMENT_ID,
        repositoryKey: REPOSITORY,
        requestId: 'upload-1',
        type: 'upload-started'
      },
      {
        attachmentId: ATTACHMENT_ID,
        markdownUrl: imageUrl,
        repositoryKey: REPOSITORY,
        requestId: 'upload-1',
        type: 'upload-succeeded'
      }
    );
    expect(state.markdown).toContain(renderedImage);

    state = issueAttachmentReducer(state, {
      repositoryKey: 'DotNaos/repository-b',
      type: 'repository-changed'
    });

    expect(state.attachments).toEqual([]);
    expect(state.markdown).toBe(`Intro\n${unrelatedImage}\n`);
    expect(state.markdown).not.toContain(imageUrl);
  });

  test('removes every duplicate attachment reference when its repository changes', () => {
    const imageUrl = storedImageUrl();
    let state = queue(createInitialIssueAttachmentState({ repositoryKey: REPOSITORY }));
    state = reduce(
      state,
      {
        attachmentId: ATTACHMENT_ID,
        repositoryKey: REPOSITORY,
        requestId: 'upload-1',
        type: 'upload-started'
      },
      {
        attachmentId: ATTACHMENT_ID,
        markdownUrl: imageUrl,
        repositoryKey: REPOSITORY,
        requestId: 'upload-1',
        type: 'upload-succeeded'
      }
    );
    state = issueAttachmentReducer(state, {
      markdown: `${state.markdown}\n${state.markdown}`,
      type: 'markdown-changed'
    });

    state = issueAttachmentReducer(state, {
      repositoryKey: 'DotNaos/repository-b',
      type: 'repository-changed'
    });

    expect(state.attachments).toEqual([]);
    expect(state.markdown).not.toContain(imageUrl);
  });

  test('builds safe initial and partial issue bodies without local placeholders', () => {
    const firstId = '00000000-0000-4000-8000-000000000001';
    const secondId = '00000000-0000-4000-8000-000000000002';
    let state = queue(
      createInitialIssueAttachmentState({
        markdown: 'Before\n\nAfter',
        repositoryKey: REPOSITORY
      }),
      { attachmentId: firstId, cursor: 6 }
    );
    state = queue(state, { attachmentId: secondId, cursor: state.markdown.length });
    state = reduce(
      state,
      {
        attachmentId: firstId,
        repositoryKey: REPOSITORY,
        requestId: 'upload-first',
        type: 'upload-started'
      },
      {
        attachmentId: firstId,
        markdownUrl: storedImageUrl(firstId),
        repositoryKey: REPOSITORY,
        requestId: 'upload-first',
        type: 'upload-succeeded'
      }
    );

    expect(issueAttachmentMarkdownWithoutAttachments(state)).not.toContain(
      'issue-attachments'
    );
    const partial = issueAttachmentMarkdownWithUploadedAttachments(state);
    expect(partial).toContain(storedImageUrl(firstId));
    expect(partial).not.toContain(`project-space-attachment://${secondId}`);
  });

  test('rejects invalid, duplicate, and wrong-repository queue actions', () => {
    const initial = createInitialIssueAttachmentState({ repositoryKey: REPOSITORY });
    const invalidId = issueAttachmentReducer(initial, {
      attachmentId: 'unsafe/id)',
      cursor: 0,
      mediaType: 'image/png',
      repositoryKey: REPOSITORY,
      sizeBytes: 1,
      type: 'attachment-queued'
    });
    expect(invalidId).toBe(initial);

    const wrongRepository = issueAttachmentReducer(initial, {
      attachmentId: 'safe-id',
      cursor: 0,
      mediaType: 'image/png',
      repositoryKey: 'DotNaos/other',
      sizeBytes: 1,
      type: 'attachment-queued'
    });
    expect(wrongRepository).toBe(initial);

    const queued = queue(initial);
    const duplicate = queue(queued);
    expect(duplicate).toBe(queued);
  });
});
