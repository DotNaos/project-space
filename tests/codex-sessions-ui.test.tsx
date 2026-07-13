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

const { CodexSessionsPage } = await import(
  '../src/features/codex-sessions/codex-sessions-page'
);

const machine: CodexMachine = {
  id: 'machine-mac',
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

describe('Codex sessions Variant A page', () => {
  test('renders the selected read-only history, streaming state, decisions, and stable origin', () => {
    const html = renderToStaticMarkup(
      <CodexSessionsPage
        conversations={[conversation]}
        machines={[machine]}
        now={new Date('2026-07-13T09:00:00.000Z')}
        onContinueThread={() => {}}
        onOpenProjectChatThread={() => {}}
        onResolveApproval={() => {}}
        onResolveUserInput={() => {}}
        onSelectThread={() => {}}
        selectedOrigin={{ machineId: machine.id, threadId: activeSession.threadId }}
        sessions={[activeSession]}
      />
    );

    expect(html).toContain('Loaded by Project Space');
    expect(html).toContain('History opened read-only');
    expect(html).toContain('Streaming');
    expect(html).toContain('Running — new turns wait until this thread is idle.');
    expect(html).toContain('Allow once');
    expect(html).toContain('Deny');
    expect(html).toContain('Input required');
    expect(html).toContain('machine-mac');
    expect(html).toContain('thread-149');
  });

  test('does not preselect a requested human-input choice', () => {
    const html = renderToStaticMarkup(
      <CodexSessionsPage
        conversations={[conversation]}
        machines={[machine]}
        selectedOrigin={{ machineId: machine.id, threadId: activeSession.threadId }}
        sessions={[activeSession]}
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
      />
    );
    expect(html).toContain('aria-label="Response to What should Codex know?"');
    expect(html).toContain('placeholder="Enter your response"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Submit response<\/button>/);
  });
});
