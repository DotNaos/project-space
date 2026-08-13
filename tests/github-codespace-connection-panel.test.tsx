import { describe, expect, mock, test } from 'bun:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

function passthrough({
  children
}: {
  children?: ReactNode;
  [key: string]: unknown;
}) {
  return createElement('div', null, children);
}

function passthroughWithProps({
  children,
  ...props
}: {
  children?: ReactNode;
  [key: string]: unknown;
}) {
  return createElement('div', props, children);
}

function buttonStub({
  children,
  className,
  fullWidth,
  variant
}: {
  children?: ReactNode;
  className?: string;
  fullWidth?: boolean;
  variant?: string;
}) {
  return createElement('button', {
    className,
    'data-full-width': fullWidth ? 'true' : undefined,
    'data-variant': variant
  }, children);
}

function linkStub({
  children,
  ...props
}: {
  children?: ReactNode;
  [key: string]: unknown;
}) {
  return createElement('a', props, children);
}

const Modal = Object.assign(({
  children,
  isOpen
}: {
  children?: ReactNode;
  isOpen?: boolean;
}) => (isOpen ? createElement('div', { role: 'dialog' }, children) : null), {
  Backdrop: passthrough,
  Body: passthrough,
  CloseTrigger: () => null,
  Container: passthrough,
  Dialog: passthrough,
  Footer: passthrough,
  Header: passthrough,
  Heading: passthrough,
  Icon: passthrough
});
const Alert = Object.assign(passthrough, {
  Content: passthrough,
  Description: passthrough,
  Indicator: passthrough
});
const Disclosure = Object.assign(passthrough, {
  Body: passthrough,
  Content: passthrough,
  Heading: passthrough,
  Indicator: passthrough,
  Trigger: passthrough
});
const Radio = Object.assign(passthrough, {
  Content: passthrough,
  Control: passthrough,
  Indicator: ({ children }: { children?: ReactNode | ((state: { isSelected: boolean }) => ReactNode) }) =>
    createElement('div', null, typeof children === 'function'
      ? children({ isSelected: false })
      : children)
});
const Tooltip = Object.assign(passthrough, {
  Arrow: passthrough,
  Content: passthrough,
  Trigger: passthroughWithProps
});

mock.module('@heroui/react', () => ({
  Alert,
  Button: passthrough,
  Disclosure,
  Label: passthrough,
  Link: linkStub,
  Modal,
  Radio,
  RadioGroup: passthrough,
  Tooltip
}));
mock.module('@/app/dotnaos-ui', () => ({ Button: buttonStub }));

const { copyText, GitHubCodespaceConnectionPanel } = await import(
  '../src/features/project-desktop/components/github-codespace-connection-panel'
);
const { IssueCodexStartDialog, submitIssueCodexStart } = await import(
  '../src/features/project-desktop/components/issue-codex-start-dialog'
);
const {
  githubCodespaceLaunchAction,
  GitHubCodespacePicker,
  preserveCodespaceChoices
} = await import(
  '../src/features/project-desktop/components/github-codespace-picker'
);
const { GitHubCodespaceActions } = await import(
  '../src/features/project-desktop/components/github-codespace-actions'
);

const sharedProps = {
  busy: false,
  embedded: true,
  isOpen: true,
  onAuthorizeCodex: () => undefined,
  onCheckGitHub: () => undefined,
  onOpenChange: () => undefined,
  onRetry: () => undefined
};

describe('GitHub Codespace connection panel', () => {
  test('turns one Start development action into the required Codespace step', () => {
    const base = {
      apiVersion: 1 as const,
      codespaces: [],
      message: 'Ready',
      operationId: 'codespace:test'
    };
    expect(githubCodespaceLaunchAction({ ...base, state: 'not-created' }, undefined)).toBe(
      'provision'
    );
    expect(githubCodespaceLaunchAction({
      ...base,
      codespace: { name: 'task-space', state: 'Shutdown' },
      state: 'offline'
    }, 'task-space')).toBe('start');
    expect(githubCodespaceLaunchAction({
      ...base,
      codespace: { name: 'task-space', state: 'Available' },
      connectorId: 'connector',
      environmentId: 'environment',
      state: 'ready'
    }, 'task-space')).toBe('status');
  });

  test('offers start instead of open and stop while a Codespace is offline', () => {
    const html = renderToStaticMarkup(
      <GitHubCodespaceActions
        state="Shutdown"
        onDelete={() => undefined}
        onStart={() => undefined}
        onStop={() => undefined}
      />
    );

    expect(html).toContain('Start Codespace');
    expect(html).toContain('Delete');
    expect(html).not.toContain('GitHub</button>');
    expect(html).not.toContain('>Stop<');
  });

  test('keeps general GitHub navigation out of an individual online Codespace', () => {
    const html = renderToStaticMarkup(
      <GitHubCodespaceActions
        state="Available"
        onDelete={() => undefined}
        onStart={() => undefined}
        onStop={() => undefined}
      />
    );

    expect(html).toContain('Stop');
    expect(html).toContain('Delete');
    expect(html).not.toContain('Start Codespace');
    expect(html).not.toContain('GitHub');
  });

  test('shows create first and matching Codespaces as compact radio choices', () => {
    const html = renderToStaticMarkup(
      <GitHubCodespacePicker
        codespaces={[
          { name: 'project-space--604-first', state: 'Shutdown' },
          { name: 'project-space--604-second', state: 'Available' }
        ]}
        onChange={() => undefined}
      />
    );

    expect(html).toContain('Create a new Codespace');
    expect(html).toContain('font-bold');
    expect(html).toContain('project-space--604-first');
    expect(html).toContain('project-space--604-second');
    expect(html).not.toContain('Codespace status');
    expect(html).not.toContain('Codespace Online');
    expect(html).not.toContain('Codespace Offline');
    expect(html).not.toContain('bg-emerald-400');
    expect(html.indexOf('Create a new Codespace')).toBeLessThan(
      html.indexOf('project-space--604-first')
    );
  });

  test('keeps the branch choices visible when a selected Codespace check fails', () => {
    const current = {
      apiVersion: 1 as const,
      codespaces: [{ name: 'project-space--604-existing', state: 'Available' }],
      message: 'Select a Codespace.',
      operationId: 'codespace:current',
      state: 'not-created' as const
    };
    const failed = {
      apiVersion: 1 as const,
      message: 'DATABASE_URL is required.',
      operationId: 'codespace:failed',
      state: 'failed' as const
    };

    expect(preserveCodespaceChoices(failed, current).codespaces).toEqual(
      current.codespaces
    );
  });

  test('copies the complete non-empty device code', async () => {
    let copiedValue = '';
    const previousNavigator = globalThis.navigator;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        clipboard: {
          writeText: async (value: string) => {
            copiedValue = value;
          }
        }
      }
    });

    try {
      expect(await copyText('ABCD-EFGH')).toBe(true);
      expect(copiedValue).toBe('ABCD-EFGH');
      expect(await copyText('   ')).toBe(false);
      expect(copiedValue).toBe('ABCD-EFGH');
    } finally {
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: previousNavigator
      });
    }
  });

  test('copies the complete device code through the browser selection fallback', async () => {
    const previousDocument = globalThis.document;
    const previousNavigator = globalThis.navigator;
    const previousWindow = globalThis.window;
    let asyncClipboardCalls = 0;
    let copiedValue = '';
    let selection: [number, number] | undefined;
    const textarea = {
      focus: () => undefined,
      remove: () => undefined,
      select: () => undefined,
      setAttribute: () => undefined,
      setSelectionRange: (start: number, end: number) => {
        selection = [start, end];
      },
      style: {} as Record<string, string>,
      value: ''
    };
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        clipboard: {
          writeText: async () => {
            asyncClipboardCalls += 1;
            throw new Error('Clipboard permission denied');
          }
        }
      }
    });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { isSecureContext: false }
    });
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        body: { append: () => undefined },
        createElement: () => textarea,
        execCommand: (command: string) => {
          copiedValue = textarea.value;
          return command === 'copy';
        }
      }
    });

    try {
      expect(await copyText('ABCD-EFGH')).toBe(true);
      expect(asyncClipboardCalls).toBe(0);
      expect(copiedValue).toBe('ABCD-EFGH');
      expect(selection).toEqual([0, 9]);
    } finally {
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: previousDocument
      });
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: previousNavigator
      });
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: previousWindow
      });
    }
  });

  test('shows the pending GitHub device flow inside the selected destination', () => {
    const html = renderToStaticMarkup(
      <GitHubCodespaceConnectionPanel
        {...sharedProps}
        githubFlow={{
          status: 'pending',
          userCode: 'ABCD-EFGH',
          verificationUri: 'https://github.com/login/device'
        }}
        kind="github"
      />
    );

    expect(html).toContain('Enter this one-time code on GitHub');
    expect(html).toContain('ABCD-EFGH');
    expect(html.match(/data-code-character="true"/g)).toHaveLength(8);
    expect(html.match(/data-code-separator="true"/g)).toHaveLength(1);
    expect(html).toContain('text-2xl');
    expect(html).toContain('grid-cols-4');
    expect(html).toContain('aspect-square');
    expect(html).not.toContain('md:size-16');
    expect(html).not.toContain('bg-black/25');
    expect(html).not.toContain('bg-white/[.035]');
    expect(html).toContain('bg-white/[.07]');
    expect(html).not.toContain('max-w-lg');
    expect(html).not.toContain('Copy code');
    expect(html).toContain('Open GitHub');
    expect(html).toContain('data-variant="primary"');
    expect(html).toContain('Refresh login status');
    expect(html.match(/rounded-full/g)).toHaveLength(2);
    expect(html.match(/data-full-width="true"/g)).toHaveLength(1);
    expect(html).not.toContain('role="dialog"');
  });

  test('surfaces an unavailable OAuth configuration instead of swallowing it', () => {
    const html = renderToStaticMarkup(
      <GitHubCodespaceConnectionPanel
        {...sharedProps}
        failure={{
          message: 'GitHub OAuth is not configured.',
          retry: 'github'
        }}
        kind="connection"
      />
    );

    expect(html).toContain('GitHub OAuth is not configured.');
    expect(html).toContain('Retry connection');
  });

  test('shows the runner failure once when no separate flow failure exists', () => {
    const html = renderToStaticMarkup(
      <GitHubCodespaceConnectionPanel
        {...sharedProps}
        kind="connection"
        runner={{
          apiVersion: 1,
          message: 'DATABASE_URL is required to connect machines.',
          operationId: 'codespace:test',
          state: 'failed'
        }}
      />
    );

    expect(html).toContain('DATABASE_URL is required to connect machines.');
    expect(html.match(/Retry connection/g)).toHaveLength(1);
  });
});

describe('Issue Codex start dialog', () => {
  test('dispatches the selected start before closing the dialog immediately', () => {
    const events: string[] = [];

    submitIssueCodexStart(
      () => events.push('request'),
      (isOpen) => events.push(isOpen ? 'open' : 'closed')
    );

    expect(events).toEqual(['request', 'closed']);
  });

  test('shows one row per host and keeps offline hosts in the same destination list', () => {
    const onlineTarget = {
      connectorId: 'connector-macbook',
      environmentLabel: 'macOS',
      isOnline: true,
      key: 'machine-macbook:connector-macbook:macos',
      physicalMachineId: 'machine-macbook',
      physicalMachineName: 'os-macbook',
      row: {
        connectorOptions: [],
        machineId: 'connector-macbook',
        physicalMachineId: 'machine-macbook',
        physicalMachineName: 'os-macbook'
      }
    };
    const offlineTarget = {
      connectorId: 'connector-yoga',
      environmentLabel: 'Linux',
      isOnline: false,
      key: 'machine-yoga:connector-yoga:linux',
      physicalMachineId: 'machine-yoga',
      physicalMachineName: 'os-yoga-unix',
      row: {
        connectorOptions: [],
        machineId: 'connector-yoga',
        physicalMachineId: 'machine-yoga',
        physicalMachineName: 'os-yoga-unix'
      }
    };
    const html = renderToStaticMarkup(
      <IssueCodexStartDialog
        cloudDestination={<div>Codespace choices</div>}
        groups={[{
          key: 'machine-macbook',
          name: 'os-macbook',
          targets: [{
            presentation: {
              canStart: false,
              message: 'Codex machine tasks require the Project Space database.',
              state: 'unavailable',
              stateLabel: 'Task inventory unavailable'
            },
            target: onlineTarget
          }, {
            presentation: {
              canStart: true,
              message: 'Ready',
              state: 'ready',
              stateLabel: 'Ready'
            },
            target: {
              ...onlineTarget,
              connectorId: 'connector-macbook-docker',
              environmentLabel: 'Docker',
              key: 'machine-macbook:connector-macbook-docker:docker'
            }
          }]
        }]}
        hostWakeStates={{}}
        isOpen
        offlineGroups={[{
          key: 'machine-yoga',
          name: 'os-yoga-unix',
          targets: [offlineTarget]
        }]}
        onOpenChange={() => undefined}
        onStart={() => undefined}
        onWake={() => undefined}
      />
    );

    expect(html).toContain('os-macbook');
    expect(html.match(/os-macbook/g)).toHaveLength(1);
    expect(html).not.toContain('connector-macbook-docker');
    expect(html).not.toContain('Offline destinations');
    expect(html).toContain('os-yoga-unix');
    expect(html).toContain('os-yoga-unix availability details');
    expect(html).not.toContain('bg-amber-500/10');
    expect(html).toContain('aria-label="Open GitHub Codespaces"');
    expect(html).toContain('href="https://github.com/codespaces"');
  });
});
