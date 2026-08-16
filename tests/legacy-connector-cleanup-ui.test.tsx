import { describe, expect, mock, test } from 'bun:test';
import { createElement, type ElementType, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LegacyConnectorCleanupSnapshot } from '../src/shared/legacy-connector-cleanup-api';

function element(tag: ElementType) {
  return ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
    createElement(tag, props, children);
}

mock.module('@/api/project-space-client', () => ({
  projectSpaceClient: {
    getLegacyConnectorCleanup: async () => ({ records: [], schemaVersion: 1 }),
    removeLegacyConnectors: async () => ({ requestId: 'request-1', results: [] })
  }
}));
mock.module('@/app/dotnaos-ui', () => ({
  Button: ({ children, isDisabled, onPress, ...props }: {
    children?: ReactNode;
    isDisabled?: boolean;
    onPress?(): void;
    [key: string]: unknown;
  }) => createElement('button', { ...props, disabled: isDisabled, onClick: onPress }, children),
  Chip: element('span'),
  Text: ({ as = 'span', children, ...props }: {
    as?: ElementType;
    children?: ReactNode;
    [key: string]: unknown;
  }) => createElement(as, props, children)
}));
mock.module('@heroui/react', () => {
  const overlay = (isOpen?: boolean) => ({ children }: { children?: ReactNode }) => (
    isOpen ? createElement('div', undefined, children) : null
  );
  const Modal = Object.assign(({ children, isOpen }: { children?: ReactNode; isOpen?: boolean }) => (
    isOpen ? createElement('div', undefined, children) : null
  ), {
    Backdrop: element('div'), Body: element('div'), Container: element('div'),
    Dialog: element('div'), Footer: element('div'), Header: element('div'),
    Heading: element('h2'), CloseTrigger: element('button')
  });
  const AlertDialog = Object.assign(({ children, isOpen }: { children?: ReactNode; isOpen?: boolean }) => (
    isOpen ? createElement('div', undefined, children) : null
  ), {
    Backdrop: element('div'), Body: element('div'), Container: element('div'),
    Dialog: element('div'), Footer: element('div'), Header: element('div'),
    Heading: element('h2'), Icon: element('div')
  });
  const Checkbox = Object.assign(element('label'), {
    Content: element('span'), Control: element('span'), Indicator: element('span')
  });
  return { AlertDialog, Checkbox, Modal, overlay };
});

const {
  LegacyConnectorCleanup,
  cleanupOutcomeLabel,
  cleanupRemovalRecords,
  defaultCleanupSelection,
  eligibleCleanupRecords,
  legacyConnectorRemovalScope
} = await import('../src/features/project-desktop/components/legacy-connector-cleanup');

const snapshot: LegacyConnectorCleanupSnapshot = {
  records: [
    {
      blockers: [],
      connectorId: 'connector-eligible',
      environmentId: 'environment-eligible',
      eligible: true,
      fingerprint: 'f'.repeat(64),
      label: 'Old Mac environment',
      replacement: { environmentId: 'environment-tailscale', kind: 'tailscale' }
    },
    {
      blockers: [{ count: 1, kind: 'dev_server' }],
      connectorId: 'connector-blocked',
      environmentId: 'environment-blocked',
      eligible: false,
      fingerprint: 'b'.repeat(64),
      label: 'Blocked development environment'
    }
  ],
  schemaVersion: 1
};

describe('legacy Connector cleanup UI', () => {
  test('is absent when the server reports no legacy records', () => {
    const html = renderToStaticMarkup(createElement(LegacyConnectorCleanup, {
      initialSnapshot: { records: [], schemaVersion: 1 },
      onChanged: async () => undefined
    }));

    expect(html).not.toContain('Legacy records');
  });

  test('renders only a compact review entry when records exist', () => {
    const html = renderToStaticMarkup(createElement(LegacyConnectorCleanup, {
      initialSnapshot: snapshot,
      onChanged: async () => undefined
    }));

    expect(html).toContain('Legacy records · 2');
    expect(html).toContain('Review');
    expect(html).not.toContain('Tailnet devices');
  });

  test('defaults selection to eligible rows and leaves blocked rows out of individual and bulk removal', () => {
    const selection = defaultCleanupSelection(snapshot.records);

    expect([...selection]).toEqual(['connector-eligible']);
    expect(eligibleCleanupRecords(snapshot.records, selection).map((record) => record.label)).toEqual([
      'Old Mac environment'
    ]);
    expect(cleanupRemovalRecords(eligibleCleanupRecords(snapshot.records, selection))).toEqual([{
      connectorId: 'connector-eligible', fingerprint: 'f'.repeat(64)
    }]);
  });

  test('keeps a cancelled selection unchanged and maps every partial result to a clear receipt', () => {
    const selectedBeforeCancel = defaultCleanupSelection(snapshot.records);
    const selectedAfterCancel = new Set(selectedBeforeCancel);

    expect([...selectedAfterCancel]).toEqual(['connector-eligible']);
    expect(cleanupOutcomeLabel('removed')).toBe('Removed');
    expect(cleanupOutcomeLabel('already_removed')).toBe('Already removed');
    expect(cleanupOutcomeLabel('blocked')).toBe('Blocked');
    expect(cleanupOutcomeLabel('conflict')).toBe('Changed before removal');
  });

  test('uses the exact confirmation scope required for both individual and bulk removal', () => {
    expect(legacyConnectorRemovalScope).toBe(
      'Project Space legacy records only. No Tailscale device, physical machine, provider resource, deployment target, or canonical Environment is deleted.'
    );
  });
});
