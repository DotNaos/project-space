import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { IssueAttachmentStatus } from '../src/features/project-desktop/components/issue-attachment-status';
import type { IssueAttachmentDraft } from '../src/features/project-desktop/components/issue-attachment-model';

const ATTACHMENT: IssueAttachmentDraft = {
  attachmentId: 'preview-id',
  mediaType: 'image/png',
  repositoryKey: 'DotNaos/project-space',
  requestId: null,
  sizeBytes: 2048,
  status: 'queued'
};

describe('issue attachment status', () => {
  test('renders the local image preview instead of generic-only metadata', () => {
    const html = renderToStaticMarkup(
      <IssueAttachmentStatus
        attachments={[ATTACHMENT]}
        onRemove={() => undefined}
        previewUrls={{ [ATTACHMENT.attachmentId]: 'blob:preview-id' }}
      />
    );

    expect(html).toContain('src="blob:preview-id"');
    expect(html).toContain('alt="Preview of pasted image 1"');
    expect(html).toContain('Ready to store when you save');
  });

  test('keeps removed remote storage visible after no draft attachment remains', () => {
    const html = renderToStaticMarkup(
      <IssueAttachmentStatus
        attachments={[]}
        onRemove={() => undefined}
        retainedStoredAttachmentCount={2}
      />
    );

    expect(html).toContain('2 removed images may remain stored in their repositories');
    expect(html).toContain('does not delete files that GitHub already accepted');
  });
});
