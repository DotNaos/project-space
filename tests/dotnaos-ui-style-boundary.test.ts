import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Icon } from '@dotnaos/ui/base';

const root = resolve(import.meta.dir, '..');

describe('DotNaos UI style compatibility boundary', () => {
  test('loads the complete design theme and scans published base component utilities once', async () => {
    const [appStyles, uiStyles] = await Promise.all([
      readFile(resolve(root, 'src/app/index.css'), 'utf8'),
      readFile(resolve(root, 'src/components/ui/dotnaos-ui.css'), 'utf8')
    ]);

    expect(appStyles).toContain('@import "../components/ui/dotnaos-ui.css"');
    expect(appStyles).not.toContain('@dotnaos/ui/styles.css');
    expect(uiStyles).toContain('@import "@dotnaos/ui/styles.css"');
    expect(uiStyles).toContain('@import "@dotnaos/design/tailwind-theme.css"');
    expect(uiStyles).toContain('@source "../../../node_modules/@dotnaos/ui-base/dist"');
    expect(uiStyles).toContain('DotNaos/ui#80');
  });

  test('uses the DotNaos Apple brand icon with its white dark-mode color', () => {
    const html = renderToStaticMarkup(createElement(Icon.Brand, {
      appearance: 'color',
      name: 'apple',
      size: 'm'
    }));

    expect(html).toContain('data-icon-brand="apple"');
    expect(html).toContain('dark:[--icon-brand-color:#FFFFFF]');
  });
});
