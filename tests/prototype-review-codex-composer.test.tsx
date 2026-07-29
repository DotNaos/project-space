import { describe, expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('@/features/codex-sessions/codex-composer-textarea', () => ({
  CodexComposerTextArea: (props: Record<string, unknown>) => createElement('textarea', props)
}));
mock.module('@/features/codex-sessions/codex-session-model-select', () => ({
  CodexSessionModelSelect: () => createElement('button', {
    'aria-label': 'Codex model settings',
    type: 'button'
  }, 'GPT-5.6-Sol High Fast')
}));

const { PrototypeReviewCodexComposer } = await import(
  '../src/features/pr-preview-review/prototype-review-codex-composer'
);

describe('prototype review Codex composer', () => {
  test('keeps active-turn steering as the primary send and shows queued messages above it', () => {
    const html = renderToStaticMarkup(
      <PrototypeReviewCodexComposer
        activeTurn
        annotationCount={0}
        draft="Steer this now"
        hasMessage
        images={[]}
        imageUploadPending={false}
        isConnecting={false}
        isDark
        queuedMessages={[{
          id: 'queued-1',
          imageAttachmentIds: [],
          message: 'Run this after the current turn',
          previewUrls: []
        }]}
        sending={false}
        onAttachFiles={() => undefined}
        onDraftChange={() => undefined}
        onPermissionChange={async () => undefined}
        onQueue={() => undefined}
        onRemoveImage={() => undefined}
        onRemoveQueued={() => undefined}
        onRetry={() => undefined}
        onSteerQueued={() => undefined}
        onSubmit={() => undefined}
      />
    );

    expect(html).toContain('Run this after the current turn');
    expect(html).toContain('Move this message into the active turn');
    expect(html).toContain('Queue for the next turn');
    expect(html).toContain('Send to the verified Codex task');
    expect(html).not.toContain('Switch to queueing');
  });

  test('keeps the compact dock minimal and adds settings only to the modal composer', () => {
    const common = {
      activeTurn: false,
      annotationCount: 0,
      draft: '',
      hasMessage: false,
      imageUploadPending: false,
      images: [],
      isConnecting: false,
      isDark: true,
      modelSelection: {
        disabled: false,
        models: [],
        onChange: () => undefined,
        onEffortChange: () => undefined,
        onServiceTierChange: () => undefined,
        value: 'gpt-5.6-sol'
      },
      onAttachFiles: () => undefined,
      onDraftChange: () => undefined,
      onPermissionChange: async () => undefined,
      onQueue: () => undefined,
      onRemoveImage: () => undefined,
      onRemoveQueued: () => undefined,
      onRetry: () => undefined,
      onSteerQueued: () => undefined,
      onSubmit: () => undefined,
      queuedMessages: [],
      sending: false
    };
    const compact = renderToStaticMarkup(<PrototypeReviewCodexComposer {...common} />);
    const modal = renderToStaticMarkup(
      <PrototypeReviewCodexComposer {...common} layout="modal" />
    );

    expect(compact).not.toContain('Codex model settings');
    expect(modal).toContain('Codex model settings');
    expect(modal).toContain('data-prototype-codex-composer="modal"');
    expect(modal).toContain('placeholder="Do anything"');
    expect(modal).toContain('aria-label="Change permissions"');
    expect(modal).toContain('aria-label="Context window usage unavailable"');
    expect(modal).toContain('data-prototype-codex-composer-actions="true"');
    expect(modal).toContain('title="Attach PNG or JPEG"');
    expect(modal).toContain('mt-auto flex min-w-0 items-center');
    expect(modal).not.toContain('grid-cols-[2.5rem_2.5rem_2.5rem_minmax(0,1fr)_2.5rem_2.5rem]');
    expect(compact).toContain('placeholder="Message Codex…"');
  });
});
