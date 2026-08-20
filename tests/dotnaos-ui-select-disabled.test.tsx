import { describe, expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('@/lib/utils', () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(' ')
}));

const { isSelectPopoverVisible, ListBoxItem, Select } = await import('../src/app/dotnaos-ui');

describe('DotNaos Select disabled contract', () => {
  test('disables the actual trigger so keyboard users cannot open it', () => {
    const html = renderToStaticMarkup(createElement(
      Select,
      { isDisabled: true, onChange: () => undefined, value: 'environment' },
      createElement(Select.Trigger, null, 'Environment')
    ));

    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-disabled="true"');
  });

  test('renders disabled options when a menu item is unavailable', () => {
    const html = renderToStaticMarkup(createElement(
      ListBoxItem,
      { id: 'environment', isDisabled: true },
      'Environment'
    ));

    expect(html).toContain('role="option"');
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('data-disabled="true"');
    expect(html).toContain('disabled=""');
  });

  test('hides an already-open menu as soon as the Select becomes disabled', () => {
    expect(isSelectPopoverVisible(true, false)).toBe(true);
    expect(isSelectPopoverVisible(true, true)).toBe(false);
  });
});
