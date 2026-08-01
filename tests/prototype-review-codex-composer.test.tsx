import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("@/features/codex-sessions/codex-composer-textarea", () => ({
  CodexComposerTextArea: (props: Record<string, unknown>) =>
    createElement("textarea", props),
}));
mock.module("@/features/codex-sessions/codex-session-model-select", () => ({
  CodexSessionModelSelect: () =>
    createElement(
      "button",
      {
        "aria-label": "Codex model settings",
        type: "button",
      },
      "GPT-5.6-Sol High Fast",
    ),
}));

const { PrototypeReviewCodexComposer } =
  await import("../src/features/pr-preview-review/prototype-review-codex-composer");

describe("prototype review Codex composer", () => {
  test("keeps active-turn steering as the primary send and shows queued messages above it", () => {
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
        queuedMessages={[
          {
            id: "queued-1",
            imageAttachmentIds: [],
            message: "Run this after the current turn",
            previewUrls: [],
          },
        ]}
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
      />,
    );

    expect(html).toContain("Run this after the current turn");
    expect(html).toContain("Move this message into the active turn");
    expect(html).toContain("Queue for the next turn");
    expect(html).toContain("Send to the verified Codex task");
    expect(html).not.toContain("Switch to queueing");
  });

  test("keeps the compact dock minimal and adds settings only to the modal composer", () => {
    const common = {
      activeTurn: false,
      annotationCount: 0,
      draft: "",
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
        value: "gpt-5.6-sol",
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
      sending: false,
    };
    const compact = renderToStaticMarkup(
      <PrototypeReviewCodexComposer {...common} />,
    );
    const modal = renderToStaticMarkup(
      <PrototypeReviewCodexComposer {...common} layout="modal" />,
    );

    expect(compact).not.toContain("Codex model settings");
    expect(modal).toContain("Codex model settings");
    expect(modal).toContain('data-prototype-codex-composer="modal"');
    expect(modal).toContain('placeholder="Do anything"');
    expect(modal).toContain('aria-label="Change permissions"');
    expect(modal).toContain('aria-label="Context window usage unavailable"');
    expect(modal).toContain('data-prototype-codex-composer-actions="true"');
    expect(modal).toContain('title="Attach PNG or JPEG"');
    expect(modal).toContain("mt-auto flex min-w-0 items-center");
    expect(modal).not.toContain(
      "grid-cols-[2.5rem_2.5rem_2.5rem_minmax(0,1fr)_2.5rem_2.5rem]",
    );
    expect(compact).toContain('placeholder="Do anything"');
  });

  test("integrates the current Codex message into the compact composer with a capped height", () => {
    const props = {
      activeTurn: true,
      annotationCount: 0,
      compactTrailingContent: (
        <button aria-label="Collapse Codex live chat" type="button" />
      ),
      draft: "",
      hasMessage: false,
      headerContent: (
        <div>
          <span>#437 · Frontend redesign</span>
          <button aria-label="Open full Codex chat" type="button" />
        </div>
      ),
      images: [],
      imageUploadPending: false,
      isConnecting: false,
      isDark: true,
      leadingContent: <p>Working on the compact controls now.</p>,
      queuedMessages: [],
      sending: false,
      onAttachFiles: () => undefined,
      onDraftChange: () => undefined,
      onPermissionChange: async () => undefined,
      onQueue: () => undefined,
      onRemoveImage: () => undefined,
      onRemoveQueued: () => undefined,
      onRetry: () => undefined,
      onSteerQueued: () => undefined,
      onSubmit: () => undefined,
    };
    const html = renderToStaticMarkup(
      <PrototypeReviewCodexComposer {...props} />,
    );
    const collapsedHtml = renderToStaticMarkup(
      <PrototypeReviewCodexComposer {...props} leadingContentCollapsed />,
    );

    expect(html).toContain("Working on the compact controls now.");
    expect(html).toContain("#437 · Frontend redesign");
    expect(html).toContain('aria-label="Open full Codex chat"');
    expect(html).toContain('aria-label="Collapse Codex live chat"');
    expect(html).toContain('data-prototype-codex-header="true"');
    expect(html).toContain('data-prototype-codex-stream="true"');
    expect(html).toContain('data-prototype-codex-stream-state="expanded"');
    expect(html).toContain("grid-rows-[1fr] opacity-100");
    expect(collapsedHtml).toContain(
      'data-prototype-codex-stream-state="collapsed"',
    );
    expect(collapsedHtml).toContain("grid-rows-[0fr] opacity-0");
    expect(collapsedHtml).toContain(
      "transition-[grid-template-rows,opacity] duration-300",
    );
    expect(html).toContain("max-h-32 overflow-y-auto");
    expect(html).toContain('data-prototype-codex-composer="compact"');
    expect(html).toContain('data-prototype-codex-message-panel="true"');
    expect(html).toContain(
      "mx-4 overflow-hidden rounded-[1.55rem] border",
    );
    expect(html).toContain("relative z-10 -mt-4 w-full shadow-none");
  });
});
