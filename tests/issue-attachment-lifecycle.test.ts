import { describe, expect, test } from 'bun:test';

import { IssueAttachmentLifecycle } from '../src/features/project-desktop/components/issue-attachment-lifecycle';
import type { IssueAttachmentDraft } from '../src/features/project-desktop/components/issue-attachment-model';

const REPOSITORY = 'DotNaos/project-space';

function queuedAttachment(attachmentId: string): IssueAttachmentDraft {
  return {
    attachmentId,
    mediaType: 'image/png',
    repositoryKey: REPOSITORY,
    requestId: null,
    sizeBytes: 32,
    status: 'queued'
  };
}

function failedAttachment(attachmentId: string): IssueAttachmentDraft {
  return {
    attachmentId,
    error: 'The response was lost.',
    mediaType: 'image/png',
    repositoryKey: REPOSITORY,
    requestId: `request-${attachmentId}`,
    sizeBytes: 32,
    status: 'failed'
  };
}

function uploadedAttachment(
  attachmentId: string,
  repositoryKey = REPOSITORY
): IssueAttachmentDraft {
  return {
    attachmentId,
    markdownUrl: `https://github.com/${repositoryKey}/blob/${'a'.repeat(40)}/image.png?raw=1`,
    mediaType: 'image/png',
    renderedMarkdown: '![Pasted image](https://github.com/image.png)',
    repositoryKey,
    requestId: `request-${attachmentId}`,
    sizeBytes: 32,
    status: 'uploaded'
  };
}

function lifecycle(maxPreviewCount = 10) {
  let nextUrl = 0;
  const revoked: string[] = [];
  const value = new IssueAttachmentLifecycle(
    {
      createObjectUrl: () => `blob:preview-${++nextUrl}`,
      revokeObjectUrl: (url) => revoked.push(url)
    },
    maxPreviewCount
  );
  return { lifecycle: value, revoked };
}

describe('issue attachment preview lifecycle', () => {
  test('bounds previews and revokes replaced, removed, and reset object URLs', () => {
    const controller = lifecycle(2);

    controller.lifecycle.addPreview('first', new Blob(['first']));
    controller.lifecycle.addPreview('second', new Blob(['second']));
    controller.lifecycle.addPreview('third', new Blob(['third']));

    expect(controller.lifecycle.snapshot().previewUrls).toEqual({
      second: 'blob:preview-2',
      third: 'blob:preview-3'
    });
    expect(controller.revoked).toEqual(['blob:preview-1']);

    controller.lifecycle.addPreview('second', new Blob(['replacement']));
    expect(controller.lifecycle.snapshot().previewUrls).toEqual({
      third: 'blob:preview-3',
      second: 'blob:preview-4'
    });
    expect(controller.revoked).toEqual(['blob:preview-1', 'blob:preview-2']);

    controller.lifecycle.removePreview('third');
    controller.lifecycle.reset();
    expect(controller.lifecycle.snapshot()).toEqual({
      previewUrls: {},
      retainedStoredAttachmentCount: 0
    });
    expect(controller.revoked).toEqual([
      'blob:preview-1',
      'blob:preview-2',
      'blob:preview-3',
      'blob:preview-4'
    ]);
  });

  test('records removed confirmed or attempted uploads as retained remote assets', () => {
    const controller = lifecycle();
    const uploaded = uploadedAttachment('uploaded');
    const failed = failedAttachment('failed');
    const queued = queuedAttachment('queued');
    controller.lifecycle.addPreview(uploaded.attachmentId, new Blob(['uploaded']));
    controller.lifecycle.addPreview(queued.attachmentId, new Blob(['queued']));

    expect(controller.lifecycle.observeTransition([uploaded, failed, queued], [])).toBe(true);
    expect(controller.lifecycle.snapshot()).toEqual({
      previewUrls: {},
      retainedStoredAttachmentCount: 2
    });
    expect(controller.revoked).toEqual(['blob:preview-1', 'blob:preview-2']);

    controller.lifecycle.observeTransition([uploaded], []);
    expect(controller.lifecycle.snapshot().retainedStoredAttachmentCount).toBe(2);
  });

  test('keeps the local preview while a queued image becomes stored', () => {
    const controller = lifecycle();
    const queued = queuedAttachment('image');
    const uploaded = uploadedAttachment('image');
    controller.lifecycle.addPreview(queued.attachmentId, new Blob(['image']));

    expect(controller.lifecycle.observeTransition([queued], [uploaded])).toBe(false);
    expect(controller.lifecycle.snapshot()).toEqual({
      previewUrls: { image: 'blob:preview-1' },
      retainedStoredAttachmentCount: 0
    });
    expect(controller.revoked).toEqual([]);
  });

  test('counts retained files by repository and clears that evidence on reset', () => {
    const controller = lifecycle();
    const first = uploadedAttachment('same-id', 'DotNaos/project-space');
    const second = uploadedAttachment('same-id', 'DotNaos/other');

    controller.lifecycle.observeTransition([first], []);
    controller.lifecycle.observeTransition([second], []);
    expect(controller.lifecycle.snapshot().retainedStoredAttachmentCount).toBe(2);

    controller.lifecycle.reset();
    expect(controller.lifecycle.snapshot().retainedStoredAttachmentCount).toBe(0);
  });

  test('reports existing Project Space images removed from edited Markdown', () => {
    const controller = lifecycle();
    const first = 'https://github.com/DotNaos/project-space/blob/first/image.png?raw=1';
    const second = 'https://github.com/DotNaos/project-space/blob/second/image.png?raw=1';
    controller.lifecycle.setBaselineStoredAttachmentUrls([first, second]);

    expect(controller.lifecycle.observeStoredAttachmentUrls([second])).toBe(true);
    expect(controller.lifecycle.snapshot().retainedStoredAttachmentCount).toBe(1);

    expect(controller.lifecycle.observeStoredAttachmentUrls([first, second])).toBe(true);
    expect(controller.lifecycle.snapshot().retainedStoredAttachmentCount).toBe(0);
  });
});
