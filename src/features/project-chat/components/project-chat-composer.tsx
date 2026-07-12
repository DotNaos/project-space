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
    <footer className="shrink-0 border-t border-neutral-900 bg-neutral-950/95 px-4 pb-2 pt-2.5 sm:px-5">
      <div className="mx-auto max-w-3xl">
        <div className="rounded-xl border border-neutral-700/80 bg-neutral-900/80 px-3 py-2 shadow-2xl shadow-black/30 focus-within:border-neutral-500">
          <textarea
            aria-label={`Message ${channelName}`}
            className="max-h-28 min-h-5 w-full resize-none bg-transparent text-sm leading-5 text-neutral-100 outline-none placeholder:text-neutral-400"
            disabled={disabled || isSending}
            maxLength={PROJECT_CHAT_MAX_BODY_LENGTH}
            onChange={(event) => setBody(event.currentTarget.value)}
            onKeyDown={handleKeyDown}
            placeholder={`Message #${channelName}`}
            ref={textareaRef}
            rows={1}
            value={body}
          />
          <div className="mt-1.5 flex min-w-0 items-center gap-2">
            <Text className="hidden text-[10px] text-neutral-400 sm:block">Shift ↵ for new line</Text>
            {onEditProfile ? (
              <button
                aria-label={`Edit profile for ${viewerName}`}
                className="ml-auto flex min-h-11 min-w-0 items-center gap-1.5 text-[10px] text-neutral-400 hover:text-neutral-100"
                onClick={onEditProfile}
                type="button"
              >
                <span className="truncate">Sending as {viewerName} · {viewerRole}</span>
                <UserRoundPen className="size-3.5 shrink-0" />
              </button>
            ) : (
              <Text className="ml-auto truncate text-[10px] text-neutral-400">
                Sending as {viewerName} · {viewerRole}
              </Text>
            )}
            <Button
              aria-label="Send message"
              isDisabled={disabled || isSending || !body.trim()}
              isIconOnly
              onPress={() => void send()}
              size="sm"
              variant="primary"
              className="size-8 min-h-0 rounded-full"
            >
              {isSending ? <Loader2 className="size-3.5 animate-spin" /> : <ArrowUp className="size-3.5" />}
            </Button>
          </div>
        </div>
        {error ? (
          <div aria-live="polite" className="mt-2 flex items-center justify-center gap-1.5 text-[10px] text-red-300" role="alert">
            <CircleAlert className="size-3" />
            {error}
          </div>
        ) : (
          <Text className="mt-1.5 block text-center text-[10px] leading-4 text-neutral-400">
            Shared and low priority. Native thread messages remain user-authored.
          </Text>
        )}
      </div>
    </footer>
  );
}
