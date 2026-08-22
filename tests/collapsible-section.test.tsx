import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CollapsibleSection } from '../src/components/ui/collapsible-section';

describe('CollapsibleSection', () => {
  test('renders an expanded semantic section by default', () => {
    const html = renderToStaticMarkup(createElement(
      CollapsibleSection,
      { id: 'local', summary: '3 items', title: 'Local & self-hosted' },
      createElement('p', undefined, 'Inventory table'),
    ));

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('Local &amp; self-hosted');
    expect(html).toContain('Inventory table');
    expect(html).not.toContain('uppercase');
    expect(html).not.toContain('chevron');
  });

  test('keeps a collapsed section body out of the rendered hierarchy', () => {
    const html = renderToStaticMarkup(createElement(
      CollapsibleSection,
      { defaultExpanded: false, id: 'excluded', title: 'Excluded tailnet devices' },
      createElement('p', undefined, 'Excluded table'),
    ));

    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('Excluded tailnet devices');
    expect(html).not.toContain('Excluded table');
  });

  test('can render as a visually separated top-level section', () => {
    const html = renderToStaticMarkup(createElement(
      CollapsibleSection,
      { id: 'available', insetContent: true, separated: true, summary: 3, title: 'Available Tailnet devices' },
      createElement('p', undefined, 'Devices'),
    ));

    expect(html).toContain('data-separated="true"');
    expect(html).toContain('border-b');
    expect(html).not.toContain('border-y');
    expect(html).toContain('text-text-muted');
    expect(html).toContain('data-section-summary="true">3</span>');
    expect(html).toContain('ml-4 sm:ml-6');
  });
});
