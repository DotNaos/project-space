import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  IssueMarkdown,
  isSafeIssueMarkdownImageUrl
} from '../src/features/project-desktop/components/issue-markdown';
import { loadPrivateIssueAttachmentOnce } from '../src/features/project-desktop/components/issue-markdown-image';

describe('issue Markdown images', () => {
  test('keeps a private generated image out of an unauthenticated image source', () => {
    const attachmentId = '00000000-0000-4000-8000-000000000001';
    const commitSha = 'a'.repeat(40);
    const imageUrl =
      `https://github.com/DotNaos/project-space/blob/${commitSha}/`
      + `.github/project-space/issue-attachments/${attachmentId}.png?raw=1`;
    const html = renderToStaticMarkup(
      <IssueMarkdown
        markdown={`![Private diagram](${imageUrl})`}
        repositoryFullName="DotNaos/project-space"
      />
    );

    expect(html).toContain('Private diagram');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('/api/github/issue-attachment-content?');
    expect(html).not.toContain(imageUrl);
  });

  test('does not proxy a generated path that belongs to another repository', () => {
    const imageUrl =
      `https://github.com/DotNaos/secret/blob/${'a'.repeat(40)}/`
      + '.github/project-space/issue-attachments/'
      + '00000000-0000-4000-8000-000000000001.png?raw=1';
    const html = renderToStaticMarkup(
      <IssueMarkdown
        markdown={`![Other repository](${imageUrl})`}
        repositoryFullName="DotNaos/project-space"
      />
    );

    expect(html).not.toContain(`src="${imageUrl}`);
    expect(html).toContain('Load external image: Other repository');
    expect(html).not.toContain('/api/github/issue-attachment-content?');
  });

  test('requires consent before loading an ordinary GitHub-hosted image', () => {
    const imageUrl =
      'https://github.com/DotNaos/project-space/blob/0123456789abcdef/image.png?raw=1';
    const html = renderToStaticMarkup(
      <IssueMarkdown markdown={`Before\n\n![Architecture](${imageUrl})\n\nAfter`} />
    );

    expect(html).not.toContain(`src="${imageUrl.replace('&', '&amp;')}"`);
    expect(html).toContain('Load external image: Architecture');
    expect(html).toContain('type="button"');
  });

  test('deduplicates many simultaneous loads of the same immutable private image', async () => {
    let calls = 0;
    let release!: (value: Blob) => void;
    const pending = new Promise<Blob>((resolve) => {
      release = resolve;
    });
    const loads = Array.from({ length: 50 }, () =>
      loadPrivateIssueAttachmentOnce('DotNaos/project-space\nimmutable-image', () => {
        calls += 1;
        return pending;
      })
    );

    await Promise.resolve();
    expect(calls).toBe(1);
    release(new Blob([new Uint8Array([1])], { type: 'image/png' }));
    const results = await Promise.all(loads);
    expect(results).toHaveLength(50);
    expect(new Set(results).size).toBe(1);
  });

  test('allows GitHub content hosts used for public and private repository images', () => {
    expect(isSafeIssueMarkdownImageUrl('https://raw.githubusercontent.com/a/b/main/a.png')).toBe(
      true
    );
    expect(
      isSafeIssueMarkdownImageUrl(
        'https://private-user-images.githubusercontent.com/123/image.png?jwt=opaque'
      )
    ).toBe(true);
    expect(
      isSafeIssueMarkdownImageUrl('https://user-attachments.githubusercontent.com/assets/id')
    ).toBe(true);
  });

  test('does not automatically load non-GitHub, insecure, or credentialed image URLs', () => {
    for (const imageUrl of [
      'https://attacker.example/tracker.png',
      'http://github.com/DotNaos/project-space/raw/main/image.png',
      'https://user:password@github.com/DotNaos/project-space/raw/main/image.png',
      'javascript:alert(1)'
    ]) {
      expect(isSafeIssueMarkdownImageUrl(imageUrl)).toBe(false);
      const html = renderToStaticMarkup(
        <IssueMarkdown markdown={`![Private diagram](${imageUrl})`} />
      );
      expect(html).not.toContain('<img');
      expect(html).toContain('Private diagram');
    }
  });
});
