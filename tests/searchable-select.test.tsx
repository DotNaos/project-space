import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SearchableSelect } from '../src/components/ui/searchable-select';

describe('SearchableSelect', () => {
  test('renders a searchable accessible single-select control', () => {
    const html = renderToStaticMarkup(
      <SearchableSelect
        accessibilityLabel="Host for os-macbook"
        onValueChange={() => {}}
        options={[
          { label: 'Create new Host', value: '__create_host__' },
          { label: 'os-macbook', value: 'host-macbook' },
        ]}
        value="host-macbook"
      />,
    );

    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-autocomplete="list"');
    expect(html).toContain('aria-label="Host for os-macbook"');
    expect(html).toContain('type="search"');
    expect(html).toContain('value="os-macbook"');
  });
});
