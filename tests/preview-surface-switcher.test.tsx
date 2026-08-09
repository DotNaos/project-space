import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { PreviewSurfaceSwitcher } from '../src/features/pr-preview-navigation/preview-surface-switcher';

test('renders an accessible switch between the full Preview and Prototype', () => {
  const html = renderToStaticMarkup(
    <PreviewSurfaceSwitcher current="prototype" pullRequestNumber={528} />
  );
  expect(html).toContain('aria-label="PR preview surface"');
  expect(html).toContain('Full preview');
  expect(html).toContain('Prototype');
  expect(html).toContain('aria-current="page"');
  expect(html).toContain('aria-pressed="true"');
});
