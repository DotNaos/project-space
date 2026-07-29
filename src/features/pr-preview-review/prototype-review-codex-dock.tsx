import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent
} from 'react';
import { Modal } from '@heroui/react';
import {
  Loader2,
  Maximize2,
  MessageSquarePlus
} from 'lucide-react';

import { createCodexSessionsClient } from '@/api/codex-sessions-client';
import { Text } from '@/app/dotnaos-ui';
import { CodexMarkdownMessage } from '@/features/codex-sessions/codex-markdown-message';
import { CodexSessionsController } from '@/features/codex-sessions/codex-sessions-controller';
import { codexContinueBlockReason } from '@/features/codex-sessions/codex-sessions-model';
import type { CodexConversationItem } from '@/features/codex-sessions/codex-sessions-types';
import type { CodexSessionTurnSettings } from '@/shared/codex-sessions-api';
import {
  formatPrototypeFeedback,
  type PrototypeAnnotation
} from '@/shared/prototype-annotation-bridge';
import type { PrototypeTheme } from '@/shared/prototype-canvas';
import { prototypeReviewCodexDelivery } from './prototype-review-codex-delivery';
import { PrototypeReviewCodexComposer as CodexComposer } from './prototype-review-codex-composer';
import { PrototypeReviewCodexHistory } from './prototype-review-codex-history';
import {
  removePrototypeReviewCodexImage,
  uploadPrototypeReviewCodexImage,
  validateCodexImageFile,
  type PendingCodexImage
} from './prototype-review-codex-images';
import type { PrototypeReviewDevelopmentContext } from './prototype-review-model';
import { PrototypeReviewDockAction } from './prototype-review-dock-action';
import { usePrototypeReviewCodexModels } from './use-prototype-review-codex-models';

const connectionLabels = {
  local: 'Local',
  private: 'Private route',
  tailscale: 'Tailscale'
} as const;

interface QueuedCodexMessage {
  id: string;
  imageAttachmentIds: string[];
  message: string;
  previewUrls: string[];
  settings?: CodexSessionTurnSettings;
}

interface PrototypeReviewCodexDockProps {
  annotations: readonly PrototypeAnnotation[];
  development: PrototypeReviewDevelopmentContext;
  onAnnotationsSent(): void;
  onToggleAnnotations(): void;
  theme: PrototypeTheme;
}

export function PrototypeReviewCodexDock({
  annotations,
  development,
  onAnnotationsSent,
  onToggleAnnotations,
  theme
}: PrototypeReviewCodexDockProps) {
  const controller = useMemo(() => new CodexSessionsController(createCodexSessionsClient()), []);
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState
  );
  const [draft, setDraft] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [feedbackError, setFeedbackError] = useState<string>();
  const [images, setImages] = useState<PendingCodexImage[]>([]);
  const [queuedMessages, setQueuedMessages] = useState<QueuedCodexMessage[]>([]);
  const [reconnecting, setReconnecting] = useState(false);
  const [sending, setSending] = useState(false);
  const dispatchingQueue = useRef(false);
  const origin = {
    machineId: development.machineId,
    threadId: development.threadId
  };
  const connect = useCallback(async () => {
    const nextOrigin = {
      machineId: development.machineId,
      threadId: development.threadId
    };
    setFeedbackError(undefined);
    setReconnecting(true);
    try {
      await controller.loadMachines([nextOrigin.machineId]);
      await controller.select(nextOrigin);
    } finally {
      setReconnecting(false);
    }
  }, [controller, development.machineId, development.threadId]);

  useEffect(() => {
    void connect();
  }, [connect]);

  useEffect(() => () => controller.dispose(), [controller]);

  const conversation = state.conversations.find(
    (candidate) =>
      candidate.machineId === origin.machineId && candidate.threadId === origin.threadId
  );
  const machine = state.machines.find((candidate) => candidate.id === origin.machineId);
  const session = state.sessions.find(
    (candidate) =>
      candidate.machineId === origin.machineId && candidate.threadId === origin.threadId
  );
  const modelSelection = usePrototypeReviewCodexModels(
    historyOpen && Boolean(session),
    session?.model
  );
  const streamingAssistant = [...(conversation?.items ?? [])]
    .reverse()
    .find(
      (item): item is Extract<CodexConversationItem, { kind: 'message' }> =>
        item.kind === 'message' && item.role === 'assistant' && item.streaming === true
    );

  const connecting =
    reconnecting ||
    state.reading ||
    state.loadingMachineIds.includes(origin.machineId);
  const activeTurn = session?.status === 'active' && Boolean(state.activeTurnId);
  const blockReason = connecting
    ? 'Connecting to the verified Codex task…'
    : session
      ? activeTurn
        ? undefined
        : codexContinueBlockReason(session, machine)
      : (state.errorMessage ?? 'The verified Codex task is not reachable right now.');
  const isDark = theme === 'dark';
  const hasMessage = Boolean(draft.trim()) || annotations.length > 0 || images.length > 0;
  const imageUploadPending = images.some((image) => image.status !== 'ready');

  useEffect(() => {
    if (
      dispatchingQueue.current ||
      sending ||
      connecting ||
      session?.status !== 'idle' ||
      queuedMessages.length === 0
    ) return;
    const next = queuedMessages[0]!;
    dispatchingQueue.current = true;
    setSending(true);
    setFeedbackError(undefined);
    void controller.continue(origin, next.message, next.settings, next.imageAttachmentIds)
      .then(async (result) => {
        const delivery = prototypeReviewCodexDelivery(result);
        if (!delivery.accepted) {
          if (delivery.reconnect) await connect();
          setFeedbackError(delivery.message);
          return;
        }
        next.previewUrls.forEach((url) => {
          if (url.startsWith('blob:')) URL.revokeObjectURL(url);
        });
        setQueuedMessages((current) => current.filter((message) => message.id !== next.id));
      })
      .catch((error) => {
        setFeedbackError(
          error instanceof Error ? error.message : 'Could not send the queued Codex message.'
        );
      })
      .finally(() => {
        dispatchingQueue.current = false;
        setSending(false);
      });
  }, [
    connecting,
    connect,
    controller,
    origin.machineId,
    origin.threadId,
    queuedMessages,
    sending,
    session?.status
  ]);

  async function attachFiles(files: readonly File[]) {
    setFeedbackError(undefined);
    const available = Math.max(0, 3 - images.length);
    if (available === 0) {
      setFeedbackError('You can attach up to three images.');
      return;
    }
    for (const file of [...files].slice(0, available)) {
      const validationError = validateCodexImageFile(file);
      if (validationError) {
        setFeedbackError(validationError);
        continue;
      }
      const key = crypto.randomUUID();
      const localPreviewUrl = URL.createObjectURL(file);
      setImages((current) => [
        ...current,
        {
          key,
          name: file.name,
          previewUrl: localPreviewUrl,
          status: 'uploading'
        }
      ]);
      try {
        const uploaded = await uploadPrototypeReviewCodexImage(file);
        URL.revokeObjectURL(localPreviewUrl);
        setImages((current) => current.map((image) => image.key === key
          ? {
              ...image,
              id: uploaded.id,
              previewUrl: uploaded.previewUrl,
              status: 'ready'
            }
          : image));
      } catch (error) {
        setImages((current) => current.map((image) => image.key === key
          ? { ...image, status: 'failed' }
          : image));
        setFeedbackError(
          error instanceof Error ? error.message : 'The image could not be attached.'
        );
      }
    }
  }

  function removeImage(key: string) {
    const image = images.find((candidate) => candidate.key === key);
    if (!image) return;
    if (image.previewUrl.startsWith('blob:')) URL.revokeObjectURL(image.previewUrl);
    if (image.id) void removePrototypeReviewCodexImage(image.id);
    setImages((current) => current.filter((candidate) => candidate.key !== key));
  }

  async function submit(event: FormEvent, settings?: CodexSessionTurnSettings) {
    event.preventDefault();
    const comment = formatPrototypeFeedback(draft, annotations) ||
      (images.length ? 'Please review the attached image.' : undefined);
    if (!comment || blockReason || sending || imageUploadPending) return;
    const readyImageIds = images.flatMap((image) => image.id ? [image.id] : []);
    setSending(true);
    setFeedbackError(undefined);
    try {
      const result = activeTurn
        ? await controller.steer(origin, comment, readyImageIds)
        : await controller.continue(origin, comment, settings, readyImageIds);
      const delivery = prototypeReviewCodexDelivery(result);
      if (!delivery.accepted) {
        if (delivery.reconnect) await connect();
        setFeedbackError(delivery.message);
        return;
      }
      setDraft('');
      images.forEach((image) => {
        if (image.previewUrl.startsWith('blob:')) URL.revokeObjectURL(image.previewUrl);
      });
      setImages([]);
      onAnnotationsSent();
    } catch (error) {
      setFeedbackError(
        error instanceof Error ? error.message : 'Could not send prototype feedback.'
      );
    } finally {
      setSending(false);
    }
  }

  function queueCurrentMessage(settings?: CodexSessionTurnSettings) {
    const comment = formatPrototypeFeedback(draft, annotations) ||
      (images.length ? 'Please review the attached image.' : undefined);
    if (!activeTurn || !comment || blockReason || sending || imageUploadPending) return;
    setQueuedMessages((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        imageAttachmentIds: images.flatMap((image) => image.id ? [image.id] : []),
        message: comment,
        previewUrls: images.map((image) => image.previewUrl),
        ...(settings ? { settings } : {})
      }
    ]);
    setDraft('');
    setImages([]);
    setFeedbackError(undefined);
    onAnnotationsSent();
  }

  async function steerQueuedMessage(message: QueuedCodexMessage) {
    if (!activeTurn || sending) return;
    setSending(true);
    setFeedbackError(undefined);
    try {
      const result = await controller.steer(
        origin,
        message.message,
        message.imageAttachmentIds
      );
      const delivery = prototypeReviewCodexDelivery(result);
      if (!delivery.accepted) {
        if (delivery.reconnect) await connect();
        setFeedbackError(delivery.message);
        return;
      }
      message.previewUrls.forEach((url) => {
        if (url.startsWith('blob:')) URL.revokeObjectURL(url);
      });
      setQueuedMessages((current) => current.filter(
        (candidate) => candidate.id !== message.id
      ));
    } catch (error) {
      setFeedbackError(
        error instanceof Error ? error.message : 'Could not steer the active Codex turn.'
      );
    } finally {
      setSending(false);
    }
  }

  function removeQueuedMessage(message: QueuedCodexMessage) {
    message.previewUrls.forEach((url) => {
      if (url.startsWith('blob:')) URL.revokeObjectURL(url);
    });
    message.imageAttachmentIds.forEach((id) => void removePrototypeReviewCodexImage(id));
    setQueuedMessages((current) => current.filter(
      (candidate) => candidate.id !== message.id
    ));
  }

  async function updatePermissionProfile(permissionProfileId: string) {
    setFeedbackError(undefined);
    const result = await controller.updatePermissionProfile(origin, permissionProfileId);
    const delivery = prototypeReviewCodexDelivery(result);
    if (!delivery.accepted) {
      if (delivery.reconnect) await connect();
      throw new Error(delivery.message);
    }
  }

  return (
    <>
      <section
        className="pointer-events-none relative mx-auto w-full max-w-4xl max-[1400px]:ml-auto max-[1400px]:mr-0"
        data-prototype-dev-dock="true"
      >
        {streamingAssistant && !historyOpen ? (
          <div
            aria-live="polite"
            className={`pointer-events-auto absolute bottom-[calc(100%+0.75rem)] left-1/2 flex max-h-28 w-[min(44rem,calc(100%-2rem))] -translate-x-1/2 items-start overflow-hidden rounded-2xl px-4 py-3 shadow-[0_14px_44px_rgba(0,0,0,0.34)] backdrop-blur-xl ${
              isDark ? 'bg-neutral-900/92 text-neutral-300' : 'bg-white/92 text-neutral-700'
            }`}
            data-prototype-codex-stream="true"
          >
            <CodexMarkdownMessage
              className="min-w-0 flex-1 overflow-hidden text-xs leading-[1.35rem]"
              text={streamingAssistant.text}
            />
            <Loader2 className="ml-3 size-3.5 shrink-0 animate-spin text-emerald-500" />
          </div>
        ) : null}

        <div className="grid min-w-0 grid-cols-[3rem_minmax(0,1fr)_3rem] items-end gap-2 max-[640px]:grid-cols-[2.75rem_minmax(0,1fr)]">
          <PrototypeReviewDockAction
            annotationCount={annotations.length}
            isDark={isDark}
            label={
              annotations.length
                ? `Continue adding prototype comments, ${annotations.length} saved`
                : 'Add a comment to the prototype'
            }
            onClick={onToggleAnnotations}
          >
            <MessageSquarePlus className="size-[1.125rem]" />
          </PrototypeReviewDockAction>

          <CodexComposer
            annotationCount={annotations.length}
            activeTurn={activeTurn}
            blockReason={blockReason}
            draft={draft}
            feedbackError={feedbackError}
            hasMessage={hasMessage}
            images={images}
            isDark={isDark}
            isConnecting={connecting}
            imageUploadPending={imageUploadPending}
            queuedMessages={queuedMessages}
            sending={sending}
            onAttachFiles={(files) => void attachFiles(files)}
            onDraftChange={setDraft}
            onPermissionChange={updatePermissionProfile}
            onQueue={queueCurrentMessage}
            onRemoveQueued={removeQueuedMessage}
            onRemoveImage={removeImage}
            onRetry={() => void connect()}
            onSubmit={submit}
            onSteerQueued={(message) => void steerQueuedMessage(message)}
          />

          <PrototypeReviewDockAction
            className="max-[640px]:absolute max-[640px]:bottom-[calc(100%+0.5rem)] max-[640px]:right-0"
            isDark={isDark}
            label="Open full Codex chat"
            onClick={() => setHistoryOpen(true)}
          >
            <Maximize2 className="size-[1.125rem]" />
          </PrototypeReviewDockAction>
        </div>
      </section>

      <Modal isOpen={historyOpen} onOpenChange={setHistoryOpen}>
        <Modal.Backdrop className="z-[90] bg-transparent" variant="transparent">
          <Modal.Container className="p-3 sm:p-6" placement="center" scroll="inside" size="cover">
            <Modal.Dialog
              className={`flex h-[min(56rem,calc(100dvh-1.5rem))] w-full max-w-6xl flex-col overflow-hidden shadow-[0_24px_80px_rgba(0,0,0,0.46)] sm:h-[min(56rem,calc(100dvh-3rem))] ${
                isDark ? 'bg-neutral-950 text-neutral-100' : 'bg-stone-50 text-neutral-900'
              }`}
            >
              <Modal.CloseTrigger aria-label="Close Codex conversation history" />
              <Modal.Header
                className={`block border-b px-5 py-4 pr-14 text-left sm:px-8 ${
                  isDark ? 'border-neutral-800' : 'border-stone-200'
                }`}
              >
                <Modal.Heading className="truncate text-left text-base font-semibold">
                  {session?.title ?? 'Verified PR task'}
                </Modal.Heading>
                <Text className="mt-1 block truncate text-left text-[11px] text-neutral-500">
                  {machine?.name ?? development.machineId} ·{' '}
                  {connectionLabels[development.connectionKind]}
                </Text>
              </Modal.Header>
              <Modal.Body className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-0">
                <PrototypeReviewCodexHistory
                  isDark={isDark}
                  items={conversation?.items ?? []}
                  loading={state.reading}
                  working={Boolean(streamingAssistant)}
                />
              </Modal.Body>
              <Modal.Footer
                className={`shrink-0 border-t px-3 py-3 sm:px-5 ${
                  isDark ? 'border-neutral-800' : 'border-stone-200'
                }`}
              >
                <div className="w-full min-w-0">
                  <CodexComposer
                    annotationCount={annotations.length}
                    activeTurn={activeTurn}
                    blockReason={blockReason}
                    draft={draft}
                    feedbackError={feedbackError}
                    hasMessage={hasMessage}
                    images={images}
                    isDark={isDark}
                    isConnecting={connecting}
                    imageUploadPending={imageUploadPending}
                    layout="modal"
                    modelSelection={modelSelection}
                    queuedMessages={queuedMessages}
                    sending={sending}
                    onAttachFiles={(files) => void attachFiles(files)}
                    onDraftChange={setDraft}
                    onPermissionChange={updatePermissionProfile}
                    onQueue={queueCurrentMessage}
                    onRemoveQueued={removeQueuedMessage}
                    onRemoveImage={removeImage}
                    onRetry={() => void connect()}
                    onSubmit={submit}
                    onSteerQueued={(message) => void steerQueuedMessage(message)}
                    permissionProfileId={session?.permissionProfileId}
                    permissionProfiles={session?.permissionProfiles}
                    tokenUsage={session?.tokenUsage}
                  />
                </div>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </>
  );
}
