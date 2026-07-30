import { describe, expect, mock, test } from 'bun:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import * as changelogApi from '../src/shared/pr-preview-changelog-api';
import * as prototypesApi from '../src/shared/pr-preview-changelog-prototypes';
import * as testTargetsApi from '../src/shared/pr-preview-changelog-test-targets';

function passthrough({
  children
}: {
  children?: ReactNode;
  [key: string]: unknown;
}) {
  return createElement('div', null, children);
}

const Modal = Object.assign(
  ({
    children,
    isOpen
  }: {
    children?: ReactNode;
    isOpen?: boolean;
  }) => (isOpen ? createElement('div', { role: 'dialog' }, children) : null),
  {
    Backdrop: passthrough,
    Body: passthrough,
    CloseTrigger: () => null,
    Container: passthrough,
    Dialog: passthrough,
    Footer: passthrough,
    Header: passthrough,
    Heading: passthrough,
    Icon: passthrough
  }
);

mock.module('@/lib/utils', () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(' ')
}));
mock.module('@/shared/pr-preview-changelog-api', () => changelogApi);
mock.module(
  '@/shared/pr-preview-changelog-prototypes',
  () => prototypesApi
);
mock.module(
  '@/shared/pr-preview-changelog-test-targets',
  () => testTargetsApi
);
mock.module('@heroui/react', () => ({
  Disclosure: Object.assign(passthrough, {
    Body: passthrough,
    Content: passthrough,
    Heading: passthrough,
    Indicator: passthrough,
    Trigger: passthrough
  }),
  ModalBackdrop: Modal.Backdrop,
  ModalBody: Modal.Body,
  ModalCloseTrigger: Modal.CloseTrigger,
  ModalContainer: Modal.Container,
  ModalDialog: Modal.Dialog,
  ModalFooter: Modal.Footer,
  ModalHeader: Modal.Header,
  ModalHeading: Modal.Heading,
  ModalIcon: Modal.Icon,
  ModalRoot: Modal
}));
mock.module('@/app/dotnaos-ui', () => ({
  Button: passthrough,
  Text: passthrough
}));

const { PullRequestChangelogDialog } = await import(
  '../src/features/pr-preview-changelog/pull-request-changelog-dialog'
);

const identity = {
  headSha: 'a'.repeat(40),
  pullRequestNumber: 361,
  repositoryFullName: 'DotNaos/project-space'
};

describe('pull request changelog dialog', () => {
  test('opens with exact-source guidance and a same-host Docs link', () => {
    const html = renderToStaticMarkup(
      <PullRequestChangelogDialog
        preview={{ identity, state: 'verified' }}
      />
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain('Changes in this Preview');
    expect(html).toContain(
      'Show exact-source changelog guidance for pull request previews.'
    );
    expect(html).not.toContain('>Added<');
    expect(html).not.toContain('>Changed<');
    expect(html).toContain('lucide-check');
    expect(html).toContain('Dismiss');
    expect(html).not.toContain('Continue to Preview');
    expect(html).toContain('/docs/changelog?pr=361');
    expect(html).not.toContain('https://');
  });

  test('shows an honest closed-data state for invalid build metadata', () => {
    const html = renderToStaticMarkup(
      <PullRequestChangelogDialog
        preview={{
          reasonCode: 'head-mismatch',
          state: 'invalid'
        }}
      />
    );

    expect(html).toContain('Changelog unavailable');
    expect(html).toContain(
      'could not verify its pull request identity'
    );
    expect(html).not.toContain('Preview metadata');
    expect(html).not.toContain('This build could not verify');
    expect(html).not.toContain('Open complete changelog');
    expect(html).not.toContain('<a');
  });

  test('does not render in a released build without Preview metadata', () => {
    expect(
      renderToStaticMarkup(<PullRequestChangelogDialog />)
    ).toBe('');
  });

  test('can be reopened manually after the automatic notice was dismissed', () => {
    const html = renderToStaticMarkup(
      <PullRequestChangelogDialog
        openRequestId={1}
        preview={{ identity, state: 'verified' }}
        storage={{
          getItem: () => '1',
          setItem: () => undefined
        }}
      />
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain('Changes in this Preview');
  });
});
