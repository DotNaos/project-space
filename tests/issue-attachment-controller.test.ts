import { describe, expect, test } from 'bun:test';

import {
  ISSUE_ATTACHMENT_DRAFT_MAX_BYTES,
  prepareIssueAttachmentPasteLayout,
  selectPastedIssueAttachmentImages
} from '../src/features/project-desktop/components/issue-attachment-paste';
import {
  createInitialIssueAttachmentState,
  issueAttachmentPlaceholder,
  issueAttachmentReducer,
  type IssueAttachmentAction,
  type IssueAttachmentDraft,
  type IssueAttachmentState
} from '../src/features/project-desktop/components/issue-attachment-model';
import { runPendingIssueAttachmentUploads } from '../src/features/project-desktop/components/issue-attachment-upload-controller';

const REPOSITORY = 'DotNaos/project-space';
const FIRST_ID = '19de9ca6-f47e-4b67-8242-264d3016a719';
const SECOND_ID = '1c4ba2e6-659e-474d-904b-5095a4286209';
const ISSUE_NUMBER = 187;

function storedImageUrl(attachmentId: string) {
  return `https://github.com/${REPOSITORY}/blob/${'a'.repeat(40)}/.github/project-space/issue-attachments/${ISSUE_NUMBER}/${attachmentId}.png?raw=1`;
}

function image(type: string, size: number) {
  return { size, type } as Blob;
}

function queuedAttachment(attachmentId: string, sizeBytes: number): IssueAttachmentDraft {
  return {
    attachmentId,
    mediaType: 'image/png',
    repositoryKey: REPOSITORY,
    requestId: null,
    sizeBytes,
    status: 'queued'
  };
}

function queue(
  state: IssueAttachmentState,
  attachmentId: string,
  cursor = state.markdown.length
) {
  return issueAttachmentReducer(state, {
    attachmentId,
    cursor,
    mediaType: 'image/png',
    repositoryKey: REPOSITORY,
    sizeBytes: 32,
    type: 'attachment-queued'
  });
}

describe('pasted issue image selection', () => {
  test('accepts safe images within the draft limits and reports rejected images', () => {
    const ids = [FIRST_ID, SECOND_ID];
    const selection = selectPastedIssueAttachmentImages({
      attachments: Array.from({ length: 9 }, (_, index) =>
        queuedAttachment(`existing-${index}`, 1)
      ),
      createAttachmentId: () => ids.shift()!,
      images: [image('image/png', 128), image('image/jpeg', 256)]
    });

    expect(selection.accepted).toEqual([{ attachmentId: FIRST_ID, image: image('image/png', 128) }]);
    expect(selection.error).toBe('You can attach up to 10 images to one issue draft.');
  });

  test('enforces the aggregate limit without retaining rejected image metadata', () => {
    const selection = selectPastedIssueAttachmentImages({
      attachments: [queuedAttachment('existing', ISSUE_ATTACHMENT_DRAFT_MAX_BYTES - 5)],
      createAttachmentId: () => FIRST_ID,
      images: [image('image/gif', 6)]
    });

    expect(selection.accepted).toEqual([]);
    expect(selection.error).toBe('Pasted images can use up to 50 MiB per issue draft.');
  });

  test('lays multiple generic placeholders at the exact caret with Markdown separation', () => {
    const layout = prepareIssueAttachmentPasteLayout({
      attachmentIds: [FIRST_ID, SECOND_ID],
      cursor: 6,
      markdown: 'BeforeAfter'
    });
    let state = createInitialIssueAttachmentState({
      markdown: layout.markdown,
      repositoryKey: REPOSITORY
    });
    state = queue(state, FIRST_ID, layout.insertionCursors[0]);
    state = queue(state, SECOND_ID, layout.insertionCursors[1]);

    const expected = `Before\n\n${issueAttachmentPlaceholder(FIRST_ID)}\n\n${issueAttachmentPlaceholder(SECOND_ID)}\n\nAfter`;
    expect(state.markdown).toBe(expected);
    expect(layout.selectionEnd).toBe(expected.indexOf('\n\nAfter'));
  });
});

describe('pending issue image uploads', () => {
  function controllerState() {
    let state = createInitialIssueAttachmentState({ repositoryKey: REPOSITORY });
    state = queue(state, FIRST_ID);
    state = queue(state, SECOND_ID);
    const images = new Map([
      [FIRST_ID, new Blob(['first'], { type: 'image/png' })],
      [SECOND_ID, new Blob(['second'], { type: 'image/png' })]
    ]);
    const apply = (action: IssueAttachmentAction) => {
      state = issueAttachmentReducer(state, action);
      return state;
    };
    return { apply, getState: () => state, images };
  }

  test('uploads sequentially, preserves partial success, and retries only the failure', async () => {
    const controller = controllerState();
    const calls: string[] = [];
    let requestNumber = 0;
    const firstResult = await runPendingIssueAttachmentUploads({
      apply: controller.apply,
      createRequestId: () => `request-${++requestNumber}`,
      getImage: (id) => controller.images.get(id),
      getState: controller.getState,
      isCurrentRepository: (key) => key === REPOSITORY,
      issueNumber: ISSUE_NUMBER,
      registerAbortController: () => undefined,
      repositoryKey: REPOSITORY,
      upload: async (request) => {
        calls.push(request.attachmentId);
        if (request.attachmentId === SECOND_ID) throw new Error('GitHub rejected this image.');
        return {
          attachmentId: request.attachmentId,
          fullName: REPOSITORY,
          issueNumber: ISSUE_NUMBER,
          markdownUrl: storedImageUrl(request.attachmentId),
          mediaType: 'image/png',
          sizeBytes: request.image.size,
          status: 'connected'
        };
      }
    });

    expect(calls).toEqual([FIRST_ID, SECOND_ID]);
    expect(firstResult.completed).toBe(false);
    expect(controller.getState().attachments.map(({ status }) => status)).toEqual([
      'uploaded',
      'failed'
    ]);
    expect(controller.getState().markdown).toContain(
      storedImageUrl(FIRST_ID)
    );
    expect(controller.getState().markdown).toContain(issueAttachmentPlaceholder(SECOND_ID));
    expect(firstResult.persistableMarkdown).toContain(storedImageUrl(FIRST_ID));
    expect(firstResult.persistableMarkdown).not.toContain('project-space-attachment:');

    calls.length = 0;
    const retryResult = await runPendingIssueAttachmentUploads({
      apply: controller.apply,
      createRequestId: () => `request-${++requestNumber}`,
      getImage: (id) => controller.images.get(id),
      getState: controller.getState,
      isCurrentRepository: (key) => key === REPOSITORY,
      issueNumber: ISSUE_NUMBER,
      registerAbortController: () => undefined,
      repositoryKey: REPOSITORY,
      upload: async (request) => {
        calls.push(request.attachmentId);
        return {
          attachmentId: request.attachmentId,
          fullName: REPOSITORY,
          issueNumber: ISSUE_NUMBER,
          markdownUrl: storedImageUrl(request.attachmentId),
          mediaType: 'image/png',
          sizeBytes: request.image.size,
          status: 'connected'
        };
      }
    });

    expect(calls).toEqual([SECOND_ID]);
    expect(retryResult.completed).toBe(true);
    expect(controller.getState().attachments.map(({ status }) => status)).toEqual([
      'uploaded',
      'uploaded'
    ]);
    expect(retryResult.markdown).not.toContain('project-space-attachment:');
    expect(retryResult.persistableMarkdown).toBe(retryResult.markdown);
  });

  test('turns a bounded request timeout into a retryable failure', async () => {
    let state = queue(
      createInitialIssueAttachmentState({ repositoryKey: REPOSITORY }),
      FIRST_ID
    );
    const apply = (action: IssueAttachmentAction) => {
      state = issueAttachmentReducer(state, action);
      return state;
    };

    const result = await runPendingIssueAttachmentUploads({
      apply,
      createRequestId: () => 'request-timeout',
      getImage: () => new Blob(['image'], { type: 'image/png' }),
      getState: () => state,
      isCurrentRepository: (key) => key === REPOSITORY,
      issueNumber: ISSUE_NUMBER,
      registerAbortController: () => undefined,
      repositoryKey: REPOSITORY,
      timeoutMs: 5,
      upload: (_request, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        })
    });

    expect(result.completed).toBe(false);
    expect(state.attachments[0]).toMatchObject({
      error: 'GitHub took too long to store this image. Save again to retry.',
      status: 'failed'
    });
  });

  test('stops waiting when an uploader ignores the timeout signal', async () => {
    let state = queue(
      createInitialIssueAttachmentState({ repositoryKey: REPOSITORY }),
      FIRST_ID
    );
    const apply = (action: IssueAttachmentAction) => {
      state = issueAttachmentReducer(state, action);
      return state;
    };

    const result = await runPendingIssueAttachmentUploads({
      apply,
      createRequestId: () => 'request-late',
      getImage: () => new Blob(['image'], { type: 'image/png' }),
      getState: () => state,
      isCurrentRepository: (key) => key === REPOSITORY,
      issueNumber: ISSUE_NUMBER,
      registerAbortController: () => undefined,
      repositoryKey: REPOSITORY,
      timeoutMs: 5,
      upload: () => new Promise(() => undefined)
    });

    expect(result.completed).toBe(false);
    expect(state.attachments[0]).toMatchObject({
      error: 'GitHub took too long to store this image. Save again to retry.',
      status: 'failed'
    });
    expect(state.markdown).toContain(issueAttachmentPlaceholder(FIRST_ID));
  });
});
