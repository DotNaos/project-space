import { describe, expect, mock, test } from 'bun:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('@/lib/utils', () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(' ')
}));

function passthrough(tag: string) {
  return ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => (
    createElement(tag, props, children)
  );
}

const Tooltip = Object.assign(passthrough('div'), {
  Arrow: () => null,
  Content: ({ children, placement: _placement, showArrow: _showArrow }: {
    children?: ReactNode;
    placement?: string;
    showArrow?: boolean;
  }) => createElement('span', null, children),
  Trigger: passthrough('div')
});

mock.module('@/app/dotnaos-ui', () => ({
  Button: ({ children, isDisabled, isIconOnly: _icon, onPress, variant: _variant, ...props }: {
    children?: ReactNode;
    isDisabled?: boolean;
    isIconOnly?: boolean;
    onPress?(): void;
    variant?: string;
    [key: string]: unknown;
  }) => createElement('button', { ...props, disabled: isDisabled, onClick: onPress }, children),
  Dropdown: passthrough('div'),
  DropdownItem: passthrough('div'),
  DropdownMenu: passthrough('div'),
  DropdownPopover: passthrough('div'),
  DropdownTrigger: passthrough('button'),
  Surface: passthrough('div'),
  Text: passthrough('span'),
  Tooltip
}));

const { AppRail } = await import(
  '../src/features/project-desktop/components/app-rail'
);

describe('Project desktop primary navigation', () => {
  test('keeps Codex inside Chat and limits the rail to primary destinations', () => {
    const html = renderToStaticMarkup(
      <AppRail
        activeSection="chat"
        hasContextPanel={false}
        isContextPanelOpen={false}
        onOpenChat={() => {}}
        onOpenHome={() => {}}
        onOpenProjects={() => {}}
        onOpenSettings={() => {}}
        onToggleContextPanel={() => {}}
      />
    );

    expect(html).toContain('data-testid="sidebar-home"');
    expect(html).toContain('data-testid="sidebar-chat"');
    expect(html).toContain('data-testid="sidebar-projects"');
    expect(html).toContain('data-testid="sidebar-settings"');
    expect(html).not.toContain('data-testid="sidebar-codex"');
    expect(html).not.toContain('data-testid="sidebar-topology"');
    expect(html).not.toContain('data-testid="sidebar-machines"');
  });
});
