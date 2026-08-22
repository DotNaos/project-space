import { describe, expect, test } from 'bun:test';
import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { Terminal, type TerminalHandle } from '../src/components/ui/terminal';

describe('Terminal', () => {
  test('renders a transport-neutral DotNaos token surface', () => {
    const ref = createRef<TerminalHandle>();
    const html = renderToStaticMarkup(createElement(Terminal, {
      accessibilityLabel: 'SSH terminal for os-macbook',
      onData() {},
      ref
    }));

    expect(html).toContain('role="application"');
    expect(html).toContain('aria-label="SSH terminal for os-macbook"');
    expect(html).toContain('--term-bg:var(--color-bg-0)');
    expect(html).toContain('--term-fg:var(--color-text)');
    expect(html).not.toContain('WebSocket');
    expect(html).not.toContain('ssh');
  });
});
