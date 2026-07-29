import type { ClipboardEvent, FormEvent } from 'react';
import {
  ArrowUp,
  CircleAlert,
  CornerDownRight,
  ListPlus,
  Loader2,
  Plus,
  RefreshCw,
  Trash2
} from 'lucide-react';

import { CodexComposerTextArea } from '@/features/codex-sessions/codex-composer-textarea';
import {
  CodexSessionModelSelect,
  type CodexSessionModelSelection
} from '@/features/codex-sessions/codex-session-model-select';
import type {
  CodexSessionPermissionProfile,
  CodexSessionTokenUsage,
  CodexSessionTurnSettings
} from '@/shared/codex-sessions-api';
import { PrototypeReviewCodexContextControl } from './prototype-review-codex-context-control';
import type { PendingCodexImage } from './prototype-review-codex-images';
import { PrototypeReviewCodexPermissionControl } from './prototype-review-codex-permission-control';

export function PrototypeReviewCodexComposer({
  annotationCount,
  activeTurn,
  blockReason,
  draft,
  feedbackError,
  hasMessage,
  images,
  imageUploadPending,
  isDark,
  isConnecting,
  layout = 'compact',
  modelSelection,
  onAttachFiles,
  onDraftChange,
  onPermissionChange,
  onQueue,
  onRemoveQueued,
  onRemoveImage,
  onRetry,
  onSubmit,
  onSteerQueued,
  queuedMessages,
  permissionProfileId,
  permissionProfiles = [],
  sending,
  tokenUsage
}: {
  annotationCount: number;
  activeTurn: boolean;
  blockReason?: string;
  draft: string;
  feedbackError?: string;
  hasMessage: boolean;
  images: readonly PendingCodexImage[];
  imageUploadPending: boolean;
  isDark: boolean;
  isConnecting: boolean;
  layout?: 'compact' | 'modal';
  modelSelection?: CodexSessionModelSelection;
  onAttachFiles(files: readonly File[]): void;
  onDraftChange(value: string): void;
  onPermissionChange(profileId: string): Promise<void>;
  onQueue(settings?: CodexSessionTurnSettings): void;
  onRemoveQueued(message: QueuedComposerMessage): void;
  onRemoveImage(key: string): void;
  onRetry(): void;
  onSubmit(event: FormEvent, settings?: CodexSessionTurnSettings): void;
  onSteerQueued(message: QueuedComposerMessage): void;
  queuedMessages: readonly QueuedComposerMessage[];
  permissionProfileId?: string;
  permissionProfiles?: readonly CodexSessionPermissionProfile[];
  sending: boolean;
  tokenUsage?: CodexSessionTokenUsage;
}) {
  const modal = layout === 'modal';
  const selectedSettings = modelSelection?.override;
  return (
    <div className="pointer-events-auto min-w-0">
      {feedbackError ? (
        <div className="mb-2 flex items-start gap-2 px-2 text-[10px] leading-4 text-rose-400">
          <CircleAlert className="mt-0.5 size-3 shrink-0" />
          {feedbackError}
        </div>
      ) : null}
      {queuedMessages.length ? (
        <div className="mb-1.5 space-y-1">
          {queuedMessages.map((message) => (
            <div
              className={`flex h-10 min-w-0 items-center gap-2 rounded-full px-3 text-xs shadow-[0_10px_34px_rgba(0,0,0,0.24)] backdrop-blur-xl ${
                isDark ? 'bg-neutral-900/95 text-neutral-300' : 'bg-stone-100/95 text-neutral-700'
              }`}
              key={message.id}
            >
              <ListPlus className="size-3.5 shrink-0 text-neutral-500" />
              <span className="min-w-0 flex-1 truncate">{message.message}</span>
              {activeTurn ? (
                <button
                  className="flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-neutral-500 transition hover:bg-neutral-800 hover:text-neutral-100"
                  disabled={sending}
                  onClick={() => onSteerQueued(message)}
                  title="Move this message into the active turn"
                  type="button"
                >
                  <CornerDownRight className="size-3.5" />
                  <span>Steer</span>
                </button>
              ) : null}
              <button
                aria-label="Remove queued message"
                className="grid size-7 shrink-0 place-items-center rounded-full text-neutral-500 transition hover:bg-neutral-800 hover:text-neutral-100"
                disabled={sending}
                onClick={() => onRemoveQueued(message)}
                type="button"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <form
        className={`w-full min-w-0 shadow-[0_18px_58px_rgba(0,0,0,0.34)] backdrop-blur-xl ${
          modal
            ? 'flex min-h-[7rem] flex-col rounded-[1.6rem] px-3 pb-3 pt-4'
            : 'flex min-h-12 flex-wrap items-end gap-1 rounded-[1.75rem] p-1.5 max-[640px]:min-h-11 max-[640px]:p-1'
        } ${
          isDark
            ? modal
              ? 'bg-neutral-800/95 text-neutral-100'
              : 'bg-neutral-900/95 text-neutral-100'
            : 'bg-stone-100/95 text-neutral-900'
        }`}
        data-prototype-codex-composer={layout}
        onSubmit={(event) => onSubmit(event, selectedSettings)}
      >
        {images.length ? (
          <div className="flex w-full min-w-0 gap-2 overflow-x-auto px-2 pb-1 pt-1">
            {images.map((image) => (
              <div className="group relative size-16 shrink-0" key={image.key}>
                <img
                  alt={image.name}
                  className={`size-full rounded-xl object-cover ${
                    image.status === 'failed' ? 'opacity-40' : ''
                  }`}
                  src={image.previewUrl}
                />
                {image.status === 'uploading' ? (
                  <span className="absolute inset-0 grid place-items-center rounded-xl bg-black/45">
                    <Loader2 className="size-4 animate-spin text-white" />
                  </span>
                ) : null}
                <button
                  aria-label={`Remove ${image.name}`}
                  className="absolute -right-1 -top-1 grid size-5 place-items-center rounded-full bg-neutral-950 text-xs text-white shadow"
                  onClick={() => onRemoveImage(image.key)}
                  type="button"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : null}
        {!modal ? (
          <AttachImageControl
            blocked={Boolean(blockReason) || sending || images.length >= 3}
            isDark={isDark}
            onAttachFiles={onAttachFiles}
          />
        ) : null}
        <CodexComposerTextArea
          aria-label="Send feedback to the verified Codex task"
          className={`max-h-24 min-w-0 flex-1 resize-none border-0 bg-transparent px-3 text-sm leading-6 outline-none ${
            modal
              ? '!min-h-10 w-full flex-none px-1 !pb-2 !pt-0 text-[14px] leading-6'
              : '!min-h-9 !py-1.5'
          } ${
            isDark
              ? 'text-neutral-100 placeholder:text-neutral-500 disabled:text-neutral-500'
              : 'text-neutral-900 placeholder:text-neutral-500'
          } ${modal ? '' : 'max-[640px]:text-xs'}`}
          disabled={Boolean(blockReason) || sending}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
              return;
            }
            if (
              activeTurn &&
              event.key === 'Tab' &&
              !event.shiftKey &&
              hasMessage &&
              !imageUploadPending
            ) {
              event.preventDefault();
              onQueue(selectedSettings);
            }
          }}
          onPaste={(event) => {
            const images = pastedImages(event);
            if (!images.length) return;
            event.preventDefault();
            onAttachFiles(images);
          }}
          onChange={(event) => onDraftChange(event.target.value)}
          placeholder={
            modal
              ? 'Do anything'
              : blockReason ?? (annotationCount ? 'Send comment…' : 'Message Codex…')
          }
          title={modal && blockReason ? blockReason : undefined}
          value={draft}
        />

        {modal ? (
          <div
            className="mt-auto flex min-w-0 items-center gap-0.5"
            data-prototype-codex-composer-actions="true"
          >
            <AttachImageControl
              blocked={Boolean(blockReason) || sending || images.length >= 3}
              isDark={isDark}
              modal
              onAttachFiles={onAttachFiles}
            />
            <PrototypeReviewCodexPermissionControl
              activeProfileId={permissionProfileId}
              disabled={isConnecting || !permissionProfiles.length}
              isDark={isDark}
              onChange={onPermissionChange}
              profiles={permissionProfiles}
            />
            <div className="min-w-2 flex-1" />
            <PrototypeReviewCodexContextControl
              isDark={isDark}
              tokenUsage={tokenUsage}
            />
            {modelSelection ? (
              <div className="min-w-0 max-w-52">
                <CodexSessionModelSelect {...modelSelection} />
              </div>
            ) : null}
            {activeTurn ? (
              <QueueButton
                disabled={!hasMessage || sending || imageUploadPending}
                isDark={isDark}
                onQueue={() => onQueue(selectedSettings)}
              />
            ) : null}
            <SubmitButton
              blockReason={blockReason}
              disabled={!hasMessage || sending || imageUploadPending}
              isConnecting={isConnecting}
              isDark={isDark}
              modal
              onRetry={onRetry}
              sending={sending}
            />
          </div>
        ) : (
          <>
            {activeTurn ? (
              <QueueButton
                disabled={!hasMessage || sending || imageUploadPending}
                isDark={isDark}
                onQueue={() => onQueue(selectedSettings)}
              />
            ) : null}
            <SubmitButton
              blockReason={blockReason}
              disabled={!hasMessage || sending || imageUploadPending}
              isConnecting={isConnecting}
              isDark={isDark}
              onRetry={onRetry}
              sending={sending}
            />
          </>
        )}
      </form>
    </div>
  );
}

function AttachImageControl({
  blocked,
  isDark,
  modal = false,
  onAttachFiles
}: {
  blocked: boolean;
  isDark: boolean;
  modal?: boolean;
  onAttachFiles(files: readonly File[]): void;
}) {
  return (
    <label
      aria-label="Attach an image"
      className={`grid size-9 shrink-0 cursor-pointer place-items-center rounded-full transition ${
        blocked
          ? 'pointer-events-none opacity-35'
          : isDark
            ? 'text-neutral-400 hover:bg-neutral-700/80 hover:text-neutral-100'
            : 'text-neutral-500 hover:bg-white hover:text-neutral-900'
      }`}
      title="Attach PNG or JPEG"
    >
      <Plus className={modal ? 'size-5' : 'size-4'} />
      <input
        accept="image/jpeg,image/png"
        className="sr-only"
        disabled={blocked}
        multiple
        onChange={(event) => {
          if (event.target.files?.length) onAttachFiles([...event.target.files]);
          event.target.value = '';
        }}
        type="file"
      />
    </label>
  );
}

function pastedImages(event: ClipboardEvent<HTMLTextAreaElement>) {
  const itemImages = [...event.clipboardData.items]
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .flatMap((item) => {
      const file = item.getAsFile();
      return file ? [file] : [];
    });
  return itemImages.length
    ? itemImages
    : [...event.clipboardData.files].filter((file) => file.type.startsWith('image/'));
}

function QueueButton({
  disabled,
  isDark,
  onQueue
}: {
  disabled: boolean;
  isDark: boolean;
  onQueue(): void;
}) {
  return (
    <button
      aria-label="Queue for the next turn"
      className={`grid size-9 shrink-0 cursor-pointer place-items-center rounded-full transition disabled:cursor-default disabled:opacity-30 ${
        isDark
          ? 'text-neutral-400 hover:bg-neutral-700/80 hover:text-white'
          : 'text-neutral-500 hover:bg-white hover:text-neutral-900'
      }`}
      disabled={disabled}
      onClick={onQueue}
      title="Queue for the next turn (Tab)"
      type="button"
    >
      <ListPlus className="size-4" />
    </button>
  );
}

function SubmitButton({
  blockReason,
  disabled,
  isConnecting,
  isDark,
  modal = false,
  onRetry,
  sending
}: {
  blockReason?: string;
  disabled: boolean;
  isConnecting: boolean;
  isDark: boolean;
  modal?: boolean;
  onRetry(): void;
  sending: boolean;
}) {
  const className = `grid shrink-0 cursor-pointer place-items-center rounded-full transition disabled:cursor-default disabled:opacity-30 ${
    modal ? 'size-10' : 'size-9'
  } ${
    isDark
      ? 'bg-neutral-100 text-neutral-900 hover:bg-white'
      : 'bg-neutral-900 text-white hover:bg-black'
  }`;
  if (blockReason) {
    return (
      <button
        aria-label="Retry Codex connection"
        className={className}
        disabled={isConnecting}
        onClick={onRetry}
        title={blockReason}
        type="button"
      >
        {isConnecting ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <RefreshCw className="size-4" />
        )}
      </button>
    );
  }
  return (
    <button
      aria-label="Send to the verified Codex task"
      className={className}
      disabled={disabled}
      type="submit"
    >
      {sending ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <ArrowUp className="size-4" />
      )}
    </button>
  );
}

interface QueuedComposerMessage {
  id: string;
  imageAttachmentIds: string[];
  message: string;
  previewUrls: string[];
}
