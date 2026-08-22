import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');

describe('DotNaos UI devtools compatibility boundary', () => {
  test('keeps the upstream Prism ordering workaround behind one local import', async () => {
    const [entrypoint, boundary] = await Promise.all([
      readFile(resolve(root, 'src/app-entry.tsx'), 'utf8'),
      readFile(resolve(root, 'src/components/ui/dotnaos-ui-devtools.tsx'), 'utf8')
    ]);
    expect(entrypoint).toContain("from '@/components/ui/dotnaos-ui-devtools'");
    expect(entrypoint).not.toContain("from '@dotnaos/ui/devtools'");
    expect(boundary.indexOf("import('@dotnaos/ui/code-editor')"))
      .toBeLessThan(boundary.indexOf("import('@dotnaos/ui/devtools')"));
    expect(boundary).toContain('https://github.com/DotNaos/ui/issues/78');
    expect(entrypoint).not.toContain('defaultShowComponents');
    expect(entrypoint).not.toContain('defaultInspectSpacing');
    expect(entrypoint).not.toContain('defaultToolbarExpanded');
    expect(entrypoint).toContain('project-space-ui-dev-toolbar-v1');
  });
});
