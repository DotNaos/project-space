import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowUp, CircleAlert, Loader2, UserRoundPen } from 'lucide-react';
import { Button, Text } from '@/app/dotnaos-ui';
import { PROJECT_CHAT_MAX_BODY_LENGTH } from '@/shared/project-chat-api';
import { isProjectChatMessageSafe } from '../project-chat-message-safety';

export function ProjectChatComposer({
  channelName = 'general',
  disabled = false,
  onEditProfile,
  onSend,
  viewerName = 'Olli',
  viewerRole = 'Human'
}: {
  channelName?: string;
  disabled?: boolean;
  onEditProfile?(): void;
  onSend(body: string): Promise<void> | void;
  viewerName?: string;
  viewerRole?: string;
}) {
  const [body, setBody] = useState('');
  const [error, setError] = useState('');
  const [isSending, setIsSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 112)}px`;
    textarea.style.overflowY = textarea.scrollHeight > 112 ? 'auto' : 'hidden';
  }, [body]);

  async function send() {
    const message = body.trim();
    if (!message || disabled || isSending) {
      return;
    }

    if (!isProjectChatMessageSafe(message)) {
      setError('This message may contain a secret. It was not sent.');
      return;
    }

    setError('');
    setIsSending(true);
    try {
      await onSend(message);
      setBody('');
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : 'Message could not be sent.');
    } finally {
      setIsSending(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  }

  return (
    <footer className="shrink-0 border-t border-neutral-800/70 pb-2 pt-3">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-end gap-2 rounded-2xl bg-white/[.05] px-3 py-2 transition focus-within:bg-white/[.07]">
          <textarea
            aria-label={`Message ${channelName}`}
            className="max-h-28 min-h-6 w-full resize-none bg-transparent py-1 text-sm leading-6 text-neutral-100 outline-none placeholder:text-neutral-600"
            disabled={disabled || isSending}
            maxLength={PROJECT_CHAT_MAX_BODY_LENGTH}
            onChange={(event) => setBody(event.currentTarget.value)}
            onKeyDown={handleKeyDown}
            placeholder={`Message #${channelName}`}
            ref={textareaRef}
            rows={1}
            value={body}
          />
          <Button
            aria-label="Send message"
            isDisabled={disabled || isSending || !body.trim()}
            isIconOnly
            onPress={() => void send()}
            size="sm"
            variant="primary"
            // `cn` only joins, so the button's own `rounded-lg` needs overriding.
            className="size-8 min-h-0 shrink-0 !rounded-full"
          >
            {isSending ? <Loader2 className="size-3.5 animate-spin" /> : <ArrowUp className="size-4" />}
          </Button>
        </div>

        {error ? (
          <div
            aria-live="polite"
            className="mt-2 flex items-center gap-1.5 text-[11px] text-red-300/90"
            role="alert"
          >
            <CircleAlert className="size-3.5 shrink-0" />
            {error}
          </div>
        ) : (
          <div className="mt-2 flex min-w-0 items-center gap-3 text-[11px] text-neutral-600">
            <span className="hidden sm:inline">Enter sends · Shift ↵ starts a new line</span>
            {onEditProfile ? (
              <button
                aria-label={`Edit profile for ${viewerName}`}
                className="ml-auto flex min-w-0 items-center gap-1.5 transition hover:text-neutral-300"
                onClick={onEditProfile}
                type="button"
              >
                <span className="truncate">Sending as {viewerName} · {viewerRole}</span>
                <UserRoundPen className="size-3.5 shrink-0" />
              </button>
            ) : (
              <Text className="ml-auto truncate">
                Sending as {viewerName} · {viewerRole}
              </Text>
            )}
          </div>
        )}
      </div>
    </footer>
  );
}
