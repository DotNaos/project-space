import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const releasePage = readFileSync(
  'apps/docs/app/docs/releases/[minor]/page.tsx',
  'utf8',
);
const releaseRows = readFileSync(
  'apps/docs/components/release-publication-details.tsx',
  'utf8',
);
const sidebarItem = readFileSync(
  'apps/docs/components/release-sidebar-item.tsx',
  'utf8',
);
const docsPages = [
  'apps/docs/app/docs/[[...slug]]/page.tsx',
  'apps/docs/app/docs/changelog/page.tsx',
  'apps/docs/app/docs/releases/[minor]/page.tsx',
].map((path) => readFileSync(path, 'utf8'));

describe('continuous release Docs page contract', () => {
  test('uses stable anchors and scroll-following sidebar state', () => {
    expect(releasePage).toContain('ReleaseScrollSpy anchors={anchors}');
    expect(releasePage).toContain('id={anchor}');
    expect(releasePage).toContain('data-release-anchor={anchor}');
    expect(sidebarItem).toContain('activeAnchor === hash');
    expect(sidebarItem).toContain('<SidebarItem');
  });

  test('has no patch pagination or previous/next release controls', () => {
    expect(releasePage).toContain('footer={{ enabled: false }}');
    expect(releasePage).not.toContain('Pagination');
    expect(releasePage).not.toContain('Previous release');
    expect(releasePage).not.toContain('Next release');
  });

  test('uses C-style editorial rows that stack on narrow screens', () => {
    expect(releaseRows).toContain(
      'sm:grid-cols-[8rem_minmax(0,1fr)]',
    );
    expect(releaseRows).toContain(
      'className="grid gap-3 border-t',
    );
    expect(releaseRows).toContain('min-w-0');
    expect(releasePage).not.toContain('<Card');
  });

  test('shows verified version identity on every Docs page shape', () => {
    for (const source of docsPages) {
      expect(source).toContain('<DocsArticleIdentity');
    }
  });
});
