import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Drawer } from '../src/components/ui/drawer';

describe('Drawer', () => {
  test('does not render a client portal during server rendering', () => {
    const html = renderToStaticMarkup(createElement(
      Drawer,
      { closeLabel: 'Close', label: 'Assign device', onClose() {}, open: true },
      createElement(Drawer.Body, undefined, 'Assignment fields'),
    ));

    expect(html).toBe('');
  });
});
