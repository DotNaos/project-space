import { describe, expect, test } from 'bun:test';
import { inspectUiCopySource } from '../scripts/ui-copy-audit/audit';
import { includeWholeFile, parseChangedLines } from '../scripts/ui-copy-audit/changed-lines';

function findings(source: string) {
  return inspectUiCopySource('src/example.tsx', source)
    .map(({ code, text }) => ({ code, text }));
}

describe('DotNaos UI copy audit', () => {
  test('rejects full-caps visible copy and forced uppercase styling', () => {
    expect(findings([
      'export const Example = () => <>',
      '  <span>LOCAL & SELF-HOSTED</span>',
      '  <span className="text-xs uppercase">Local & self-hosted</span>',
      '</>;',
    ].join('\n'))).toEqual([
      { code: 'full-caps-copy', text: 'LOCAL & SELF-HOSTED' },
      { code: 'uppercase-copy-style', text: 'uppercase' },
    ]);
  });

  test('allows sentence case and the shared technical acronyms', () => {
    expect(findings([
      'export const Example = () => <>',
      '  <span>Local & self-hosted</span>',
      '  <span>UI</span>',
      '  <span>OS</span>',
      '  <span>CPU</span>',
      '  <span>RAM</span>',
      '</>;',
    ].join('\n'))).toEqual([]);
  });

  test('tracks only added diff lines and complete untracked files', () => {
    const changed = parseChangedLines([
      '+++ b/src/example.tsx',
      '@@ -4,0 +5,2 @@',
      '+first',
      '+second',
      '+++ b/src/other.tsx',
      '@@ -9 +9 @@',
      '-old',
      '+new',
    ].join('\n'));
    includeWholeFile(changed, './src/new.tsx');

    expect([...changed.get('src/example.tsx') as Set<number>]).toEqual([5, 6]);
    expect([...changed.get('src/other.tsx') as Set<number>]).toEqual([9]);
    expect(changed.get('src/new.tsx')).toBe('all');
  });
});
