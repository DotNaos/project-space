import { describe, expect, mock, test } from 'bun:test';
import { createElement, type ElementType, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  CodexConversation,
  CodexMachine,
  CodexSession
} from '../src/features/codex-sessions/codex-sessions-types';

mock.module('@/lib/utils', () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(' ')
}));

mock.module('@/app/dotnaos-ui', () => ({
  Button: ({
    children,
    fullWidth: _fullWidth,
    isDisabled,
    isIconOnly: _isIconOnly,
    onPress,
    size: _size,
    variant: _variant,
    ...props
  }: {
    children?: ReactNode;
    isDisabled?: boolean;
    onPress?(): void;
    [key: string]: unknown;
  }) => createElement('button', { ...props, disabled: isDisabled, onClick: onPress }, children),
  Chip: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => createElement('span', props, children),
  Dropdown: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  DropdownItem: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  DropdownMenu: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  DropdownPopover: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  DropdownTrigger: ({ children }: { children?: ReactNode }) => createElement('button', null, children),
  SearchField: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => (
    createElement('div', props, children)
  ),
  SearchFieldClearButton: () => null,
  SearchFieldGroup: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => (
    createElement('div', props, children)
  ),
  SearchFieldInput: (props: Record<string, unknown>) => createElement('input', props),
  SearchFieldSearchIcon: () => createElement('span', { 'data-search-icon': true }),
  ListBox: ({ children, selectedKeys: _selectedKeys, ...props }: { children?: ReactNode; selectedKeys?: Set<string>; [key: string]: unknown }) => createElement('div', props, children),
  ListBoxItem: ({ children, id, textValue: _textValue, ...props }: { children?: ReactNode; id: string; textValue?: string; [key: string]: unknown }) => createElement('button', { ...props, 'data-id': id }, children),
  Select: Object.assign(
    ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => createElement('div', props, children),
    {
      Indicator: (props: Record<string, unknown>) => createElement('span', props),
      Popover: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => createElement('div', props, children),
      Trigger: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => createElement('button', props, children)
    }
  ),
  Tab: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => createElement('button', props, children),
  TabIndicator: () => null,
  TabList: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => createElement('div', props, children),
  Tabs: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => createElement('div', props, children),
  Surface: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => createElement('div', props, children),
  Text: ({ as = 'span', children, ...props }: {
    as?: ElementType;
    children?: ReactNode;
    [key: string]: unknown;
  }) => createElement(as, props, children),
  Tooltip: Object.assign(
    ({ children }: { children?: ReactNode }) => createElement('div', null, children),
    {
      Arrow: () => null,
      Content: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
      Trigger: ({ children }: { children?: ReactNode }) => createElement('div', null, children)
    }
  )
}));

mock.module('@heroui/react', () => ({
  Button: ({ children, isDisabled, isIconOnly: _isIconOnly, size: _size, variant: _variant, ...props }: {
    children?: ReactNode;
    isDisabled?: boolean;
    isIconOnly?: boolean;
    size?: string;
    variant?: string;
    [key: string]: unknown;
  }) => createElement('button', { ...props, disabled: isDisabled }, children),
  Drawer: Object.assign(
    ({ children }: { children?: ReactNode }) => createElement('div', null, children),
    {
      Backdrop: ({ children, isOpen: _isOpen, ...props }: { children?: ReactNode; isOpen?: boolean; [key: string]: unknown }) => createElement('div', props, children),
      Body: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => createElement('div', props, children),
      CloseTrigger: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => createElement('button', props, children),
      Content: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => createElement('div', props, children),
      Dialog: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => createElement('div', props, children),
      Handle: (props: Record<string, unknown>) => createElement('div', props),
      Header: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => createElement('div', props, children),
      Heading: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => createElement('h2', props, children),
      Trigger: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => createElement('button', props, children)
    }
  ),
  Popover: Object.assign(
    ({ children }: { children?: ReactNode }) => createElement('div', null, children),
    {
      Content: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => createElement('div', props, children),
      Dialog: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => createElement('div', props, children),
      Trigger: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => createElement('button', props, children)
    }
  ),
  Spinner: (props: Record<string, unknown>) => createElement('span', { ...props, 'data-spinner': true })
}));

const { CodexSessionsPage } = await import(
  '../src/features/codex-sessions/codex-sessions-page'
);
const { CodexConversationPane } = await import(
  '../src/features/codex-sessions/codex-conversation-pane'
);
const machine: CodexMachine = {
  id: 'machine-mac',
  inventoryState: 'live',
  name: 'os-macbook',
  status: 'connected'
};

const activeSession: CodexSession = {
  cwd: '/Users/oli/projects/project-space',
  lastActivityAt: '2026-07-13T08:59:00.000Z',
  loadedByProjectSpace: true,
  machineId: machine.id,
  model: 'gpt-5',
  projectName: 'project-space',
  status: 'active',
  stored: true,
  threadId: 'thread-149',
  title: '#149 · Integrate Codex sessions'
};

const conversation: CodexConversation = {
  approvals: [{
    description: 'Allow the requested repository write on this machine.',
    id: 'approval-1',
    title: 'Write files'
  }],
  items: [
    { id: 'user-1', kind: 'message', role: 'user', text: 'Continue this session.' },
    { id: 'tool-1', kind: 'activity', label: 'Running focused tests', state: 'running' },
    { id: 'assistant-1', kind: 'message', role: 'assistant', streaming: true, text: 'I am checking the result…' }
  ],
  machineId: machine.id,
  threadId: activeSession.threadId,
  userInputRequests: [{
    id: 'input-1',
    questions: [{
      choices: [
        { description: 'Wait for the current turn to finish.', value: 'Wait until idle' },
        { description: 'Stop the current turn first.', value: 'Interrupt' }
      ],
      id: 'question-1',
      prompt: 'How should Project Space proceed?'
    }, {
      choices: [
        { value: 'Only this request' },
        { value: 'Remember for this turn' }
      ],
      id: 'question-2',
      prompt: 'How broadly should the decision apply?'
    }],
    title: 'Choose the next action'
  }]
};

describe('Canonical Codex task page', () => {
  test('claims empty history only after an available task read completes', () => {
    const common = {
      machines: [machine],
      readBrowser: async () => ({
        checkedAt: '2026-07-13T09:00:00.000Z',
        machineId: machine.id,
        state: 'never-used' as const,
        threadId: activeSession.threadId
      }),
      selectedOrigin: { machineId: machine.id, threadId: activeSession.threadId }
    };
    const loading = renderToStaticMarkup(
      <CodexSessionsPage {...common} reading sessions={[activeSession]} />
    );
    const empty = renderToStaticMarkup(
      <CodexSessionsPage
        {...common}
        conversations={[{ items: [], machineId: machine.id, threadId: activeSession.threadId }]}
        sessions={[{ ...activeSession, status: 'idle' }]}
      />
    );
    const offline = renderToStaticMarkup(
      <CodexSessionsPage
        {...common}
        conversations={[{ items: [], machineId: machine.id, threadId: activeSession.threadId }]}
        sessions={[{
          ...activeSession,
          status: 'offline',
          statusDetail: 'The owning connector is offline.'
        }]}
      />
    );

    expect(loading).toContain('Loading stored conversation');
    expect(loading).not.toContain('No stored conversation items were returned.');
    expect(empty).toContain('No stored conversation items were returned.');
    expect(offline).toContain('Stored conversation is not available right now.');
    expect(offline).toContain('The owning connector is offline.');
    expect(offline).not.toContain('No stored conversation items were returned.');
  });

  test('renders stored history for archived tasks without subscribing or substituting chat data', () => {
    const html = renderToStaticMarkup(
      <CodexSessionsPage
        conversations={[conversation]}
        machines={[machine]}
        readBrowser={async () => ({
          checkedAt: '2026-07-13T09:00:00.000Z',
          machineId: machine.id,
          state: 'never-used',
          threadId: activeSession.threadId
        })}
        selectedOrigin={{ machineId: machine.id, threadId: activeSession.threadId }}
        sessions={[{ ...activeSession, status: 'archived' }]}
      />
    );

    expect(html).toContain('Continue this session.');
    expect(html).toContain('I am checking the result');
    expect(html).not.toContain('No stored conversation items were returned.');
  });

  test('wraps long stored message content inside the narrow transcript', () => {
    const html = renderToStaticMarkup(
      <CodexConversationPane
        conversation={{
          items: [{
            id: 'long-message',
            kind: 'message',
            role: 'user',
            text: 'x'.repeat(512)
          }],
          machineId: machine.id,
          threadId: activeSession.threadId
        }}
        machine={machine}
        session={activeSession}
      />
    );

    expect(html).toContain('max-w-full');
    expect(html).toContain('break-words');
  });

  test('renders stored assistant Markdown instead of exposing its source syntax', () => {
    const html = renderToStaticMarkup(
      <CodexConversationPane
        conversation={{
          items: [{
            id: 'markdown-message',
            kind: 'message',
            role: 'assistant',
            text: [
              '## Ergebnis',
              '',
              'Das offene [Issue #185](https://github.com/DotNaos/project-space/issues/185) beschreibt es.',
              '',
              '- Maschine',
              '- Connector',
              '',
              '| Status | Ergebnis |',
              '| --- | --- |',
              '| History | Geladen |',
              '',
              '- [x] Markdown aktiv',
              '',
              '![Private host](http://127.0.0.1/private.png)',
              '',
              '```ts',
              'const machineId = "machine-mac";',
              '```',
              '',
              '<script>alert("unsafe")</script>'
            ].join('\n')
          }],
          machineId: machine.id,
          threadId: activeSession.threadId
        }}
        machine={machine}
        session={activeSession}
      />
    );

    expect(html).toContain('<h2');
    expect(html).toContain('href="https://github.com/DotNaos/project-space/issues/185"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('<ul');
    expect(html).toContain('<table');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('class="my-3 space-y-1.5 ml-0 list-none contains-task-list"');
    expect(html).toContain('task-list-item');
    expect(html).toContain('Load external image: Private host');
    expect(html).not.toContain('src="http://127.0.0.1/private.png"');
    expect(html).toContain('<pre');
    expect(html).not.toContain('[Issue #185]');
    expect(html).not.toContain('## Ergebnis');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;alert(&quot;unsafe&quot;)&lt;/script&gt;');
  });

  test('presents assistant responses as an article without repeated message identity', () => {
    const html = renderToStaticMarkup(
      <CodexConversationPane
        conversation={{
          ...conversation,
          items: [
            ...conversation.items,
            {
              id: 'assistant-2',
              kind: 'message',
              role: 'assistant',
              text: 'The follow-up stays in the same article flow.'
            }
          ]
        }}
        machine={machine}
        session={activeSession}
      />
    );

    expect(html).toContain('data-codex-transcript="article"');
    expect(html).toContain('data-codex-message-role="assistant"');
    expect(html).toContain('data-codex-message-role="user"');
    expect(html.match(/aria-label="Assistant response"/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Your message"');
    expect(html).not.toContain('data-codex-message-identity="assistant"');
    expect(html).not.toContain('lucide-square-terminal');
  });

  test('presents tool activity as a quiet icon row without a timeline rule', () => {
    const html = renderToStaticMarkup(
      <CodexConversationPane
        conversation={{
          items: [{
            activityKind: 'mcp-tool',
            id: 'tool-completed',
            kind: 'activity',
            label: 'Loaded tools',
            state: 'completed'
          }, {
            activityKind: 'status',
            detail: 'x'.repeat(512),
            id: 'tool-running',
            kind: 'activity',
            label: 'Checking',
            state: 'running'
          }, {
            id: 'legacy-completed',
            kind: 'activity',
            label: 'Completed activity',
            state: 'completed'
          }],
          machineId: machine.id,
          threadId: activeSession.threadId
        }}
        machine={machine}
        session={activeSession}
      />
    );

    expect(html).toContain('data-codex-activity-row="true"');
    expect(html).toContain('data-codex-activity-kind="mcp-tool"');
    expect(html).toContain('data-codex-activity-kind="unknown"');
    expect(html).toContain('lucide-circle-dot');
    expect(html).toContain('lucide-wrench');
    expect(html).toContain('Running:');
    expect(html).toContain('break-words');
    expect(html).not.toContain('border-l');
  });

  test('uses the compact Moodle-inspired composer surface', () => {
    const html = renderToStaticMarkup(
      <CodexConversationPane
        conversation={conversation}
        machine={machine}
        modelSelection={{
          disabled: false,
          effort: 'deep',
          models: [{
            defaultReasoningEffort: 'high',
            defaultServiceTier: 'fast',
            description: 'Best for everyday coding.',
            displayName: 'GPT-5',
            id: 'gpt-5',
            isDefault: true,
            model: 'gpt-5',
            serviceTiers: [{ description: 'Faster responses.', id: 'fast', name: 'Fast' }],
            supportedReasoningEfforts: [
              { description: 'Quick answers.', reasoningEffort: 'low' },
              { description: 'Deeper answers.', reasoningEffort: 'high' }
            ]
          }, {
            description: 'Faster for focused work.',
            displayName: 'GPT-5 mini',
            id: 'gpt-5-mini',
            isDefault: false,
            model: 'gpt-5-mini'
          }, {
            defaultReasoningEffort: 'balanced',
            defaultServiceTier: null,
            description: 'A future model supplied by the App Server.',
            displayName: 'GPT-6 Orbit',
            id: 'gpt-6-orbit',
            isDefault: false,
            model: 'gpt-6-orbit',
            serviceTiers: [{ description: 'Priority responses.', id: 'priority', name: 'Priority' }],
            supportedReasoningEfforts: [
              { description: 'Balanced reasoning.', reasoningEffort: 'balanced' },
              { description: 'Deep reasoning.', reasoningEffort: 'deep' }
            ]
          }],
          onChange: () => {},
          onEffortChange: () => {},
          onServiceTierChange: () => {},
          serviceTier: null,
          value: 'gpt-6-orbit'
        }}
        onContinue={() => {}}
        session={{ ...activeSession, status: 'idle' }}
      />
    );

    expect(html).toContain('data-codex-composer="true"');
    expect(html).toContain('min-h-[7.25rem]');
    expect(html).toContain('flex-col');
    expect(html).toContain('rounded-[1.75rem]');
    expect(html).toContain('data-codex-composer-actions="true"');
    expect(html).toContain('aria-label="Exact machine and task authorization"');
    expect(html).toContain('aria-label="Codex model settings"');
    expect(html).toContain('GPT-6 Orbit Deep');
    expect(html).toContain('data-codex-reasoning-quick="true"');
    expect(html).toContain('Intelligence Balanced');
    expect(html).toContain('Intelligence Deep');
    expect(html).toContain('>Advanced<');
    expect(html).toContain('aria-label="Model"');
    expect(html).toContain('aria-label="Intelligence"');
    expect(html).toContain('aria-label="Speed"');
    expect(html).toContain('>Standard<');
    expect(html).toContain('>Priority<');
    expect(html).toContain('aria-label="Continue this Codex session"');
    expect(html).toContain('aria-label="Send to this Codex session"');
    expect(html).toContain('rounded-full bg-neutral-100');
  });

  test('reserves narrow task-header space for the compact shell controls', () => {
    const html = renderToStaticMarkup(
      <CodexSessionsPage
        conversations={[conversation]}
        machines={[machine]}
        readBrowser={async () => ({
          checkedAt: '2026-07-13T09:00:00.000Z',
          machineId: machine.id,
          state: 'never-used',
          threadId: activeSession.threadId
        })}
        selectedOrigin={{ machineId: machine.id, threadId: activeSession.threadId }}
        sessions={[{ ...activeSession, issueNumber: 149, status: 'idle' }]}
      />
    );

    expect(html).toContain('pr-14 md:px-4');
  });

  test('renders the selected read-only history, streaming state, decisions, and stable origin', () => {
    const html = renderToStaticMarkup(
      <CodexSessionsPage
        activeTurnId="turn-active"
        conversations={[conversation]}
        machines={[machine]}
        now={new Date('2026-07-13T09:00:00.000Z')}
        onContinueThread={() => {}}
        onInterruptThread={() => {}}
        onOpenProjectChatThread={() => {}}
        onResolveApproval={() => {}}
        onResolveUserInput={() => {}}
        onSelectThread={() => {}}
        readBrowser={async () => ({
          checkedAt: '2026-07-13T09:00:00.000Z',
          machineId: machine.id,
          state: 'never-used',
          threadId: activeSession.threadId
        })}
        selectedOrigin={{ machineId: machine.id, threadId: activeSession.threadId }}
        sessions={[activeSession]}
      />
    );

    expect(html).toContain('Integrate Codex sessions');
    expect(html).toContain('Waiting for approval');
    expect(html).toContain('aria-label="Stop active Codex turn"');
    expect(html).toContain('This task is still working; a new turn can start when it becomes idle.');
    expect(html).toContain('Allow once');
    expect(html).toContain('Deny');
    expect(html).toContain('Waiting for input');
    expect(html).toContain('os-macbook');
    expect(html).not.toContain('History opened read-only');
  });

  test('does not preselect a requested human-input choice', () => {
    const html = renderToStaticMarkup(
      <CodexSessionsPage
        conversations={[conversation]}
        machines={[machine]}
        selectedOrigin={{ machineId: machine.id, threadId: activeSession.threadId }}
        sessions={[activeSession]}
        readBrowser={async () => ({
          checkedAt: '2026-07-13T09:00:00.000Z', machineId: machine.id,
          state: 'never-used', threadId: activeSession.threadId
        })}
      />
    );
    const radios = html.match(/<input[^>]+type="radio"[^>]*>/g) ?? [];

    expect(radios).toHaveLength(4);
    expect(radios.every((radio) => !radio.includes('checked'))).toBe(true);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Submit response<\/button>/);
  });

  test('renders open-ended user input without inventing a response', () => {
    const openConversation: CodexConversation = {
      ...conversation,
      userInputRequests: [{
        id: 'input-open',
        questions: [{ choices: [], id: 'explanation', prompt: 'What should Codex know?' }],
        title: 'Codex needs input'
      }]
    };
    const html = renderToStaticMarkup(
      <CodexSessionsPage
        conversations={[openConversation]}
        machines={[machine]}
        selectedOrigin={{ machineId: machine.id, threadId: activeSession.threadId }}
        sessions={[activeSession]}
        readBrowser={async () => ({
          checkedAt: '2026-07-13T09:00:00.000Z', machineId: machine.id,
          state: 'never-used', threadId: activeSession.threadId
        })}
      />
    );
    expect(html).toContain('aria-label="Response to What should Codex know?"');
    expect(html).toContain('placeholder="Enter your response"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Submit response<\/button>/);
  });
});
