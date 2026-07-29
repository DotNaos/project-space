import { useCallback, useEffect, useMemo, useState } from 'react';

import type {
  CodexConversationItemRecord,
  CodexSessionOperationResult,
  CodexSessionReadResult,
  CodexSessionStreamEvent,
  CodexSessionTurnSettings,
} from '../../../../src/shared/codex-sessions-api';
import type { PrototypeReviewLocalContext } from '../../../../src/shared/prototype-review-local-api';
import { createNativeReviewCodexClient } from './native-review-api';

export interface NativeCodexMessage {
  detail?: string;
  id: string;
  images?: readonly { dataUrl: string; id: string }[];
  kind: CodexConversationItemRecord['kind'];
  status?: CodexConversationItemRecord['status'];
  text?: string;
}

export interface NativeCodexQueueItem {
  id: string;
  imageIds: readonly string[];
  message: string;
  settings?: CodexSessionTurnSettings;
}

function flatten(result?: CodexSessionReadResult) {
  return result?.turns.flatMap((turn) => turn.items) ?? [];
}

function operationId() {
  return `native-review-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function useNativeCodexSession(
  origin: string | undefined,
  context: PrototypeReviewLocalContext | undefined
) {
  const codex = context?.codex.state === 'available' ? context.codex : undefined;
  const client = useMemo(
    () => (origin && codex ? createNativeReviewCodexClient(origin) : undefined),
    [codex?.machineId, codex?.threadId, origin]
  );
  const [result, setResult] = useState<CodexSessionReadResult>();
  const [messages, setMessages] = useState<NativeCodexMessage[]>([]);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(Boolean(client));
  const [sending, setSending] = useState(false);
  const [queue, setQueue] = useState<NativeCodexQueueItem[]>([]);
  const [activeTurnId, setActiveTurnId] = useState<string>();

  const reload = useCallback(async () => {
    if (!client || !codex) return;
    setLoading(true);
    setError(undefined);
    try {
      const next = await client.read(codex);
      setResult(next);
      setMessages(flatten(next));
      setActiveTurnId(
        next.turns
          .slice()
          .reverse()
          .find((turn) => turn.status === 'in-progress')?.id
      );
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setLoading(false);
    }
  }, [client, codex?.machineId, codex?.threadId]);

  useEffect(() => {
    setResult(undefined);
    setMessages([]);
    setActiveTurnId(undefined);
    if (!client || !codex) {
      setLoading(false);
      return;
    }
    let active = true;
    let stop: () => void = () => undefined;
    setLoading(true);
    client
      .read(codex)
      .then((next) => {
        if (!active) return;
        setResult(next);
        setMessages(flatten(next));
        setActiveTurnId(
          next.turns
            .slice()
            .reverse()
            .find((turn) => turn.status === 'in-progress')?.id
        );
        setError(undefined);
        stop = client.subscribe(
          { ...codex, afterSequence: next.streamCursor },
          (event) => {
            if (!active) return;
            setMessages((current) => applyEvent(current, event));
            if (event.type === 'session-status') {
              setResult((value) =>
                value
                  ? { ...value, session: { ...value.session, status: event.status } }
                  : value
              );
            }
            if (event.type === 'turn-completed') {
              setActiveTurnId((current) =>
                !current || current === event.turnId ? undefined : current
              );
              setResult((value) =>
                value
                  ? { ...value, session: { ...value.session, status: 'idle' } }
                  : value
              );
            }
          },
          (caught) => active && setError(messageFor(caught))
        );
      })
      .catch((caught) => active && setError(messageFor(caught)))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
      stop();
    };
  }, [client, codex?.machineId, codex?.threadId]);

  const send = useCallback(
    async (
      message: string,
      imageIds: readonly string[],
      settings?: CodexSessionTurnSettings,
      delivery?: 'new-turn' | 'steer'
    ) => {
      if (!client || !codex) throw new Error('Codex is not connected.');
      const clean = message.trim();
      if (!clean) throw new Error('Enter a message first.');
      setSending(true);
      setError(undefined);
      try {
        const response = await client.continue({
          machineId: codex.machineId,
          threadId: codex.threadId,
          ...(delivery ? { delivery } : {}),
          ...(activeTurnId && delivery === 'steer'
            ? { expectedTurnId: activeTurnId }
            : {}),
          ...(imageIds.length ? { imageAttachmentIds: [...imageIds] } : {}),
          ...(delivery === 'steer' ? {} : (settings ?? {})),
          message: clean,
          operationId: operationId(),
        });
        assertAccepted(response);
        if (response.turnId) setActiveTurnId(response.turnId);
        setMessages((current) => [
          ...current,
          {
            id: `optimistic-${response.operationId}`,
            kind: 'user-message',
            status: 'completed',
            text: clean,
          },
        ]);
        setResult((value) =>
          value
            ? { ...value, session: { ...value.session, status: 'active' } }
            : value
        );
        return response;
      } catch (caught) {
        setError(messageFor(caught));
        throw caught;
      } finally {
        setSending(false);
      }
    },
    [activeTurnId, client, codex]
  );

  const enqueue = useCallback(
    (
      message: string,
      imageIds: readonly string[],
      settings?: CodexSessionTurnSettings
    ) => {
      setQueue((current) => [
        ...current,
        {
          id: operationId(),
          imageIds,
          message: message.trim(),
          settings,
        },
      ]);
    },
    []
  );
  const removeQueued = useCallback((id: string) => {
    setQueue((current) => current.filter((item) => item.id !== id));
  }, []);

  useEffect(() => {
    if (
      sending ||
      !queue.length ||
      !result ||
      result.session.status !== 'idle'
    ) {
      return;
    }
    const next = queue[0]!;
    void send(next.message, next.imageIds, next.settings)
      .then(() => removeQueued(next.id))
      .catch(() => undefined);
  }, [queue, removeQueued, result?.session.status, send, sending]);

  return {
    active: result?.session.status === 'active',
    enqueue,
    error,
    loading,
    messages,
    queue,
    reload,
    removeQueued,
    result,
    send,
    sending,
  };
}

function applyEvent(
  current: NativeCodexMessage[],
  event: CodexSessionStreamEvent
): NativeCodexMessage[] {
  if (event.type === 'agent-message-delta') {
    const index = current.findIndex((item) => item.id === event.itemId);
    if (index < 0) {
      return [
        ...current,
        {
          id: event.itemId,
          kind: 'agent-message' as const,
          status: 'in-progress' as const,
          text: event.delta,
        },
      ];
    }
    return current.map((item, itemIndex) =>
      itemIndex === index
        ? {
            ...item,
            status: 'in-progress' as const,
            text: `${item.text ?? ''}${event.delta}`,
          }
        : item
    );
  }
  if (event.type === 'item') {
    const next = event.item;
    const optimisticIndex =
      next.kind === 'user-message'
        ? current.findIndex(
            (item) =>
              item.id.startsWith('optimistic-') && item.text === next.text
          )
        : -1;
    if (optimisticIndex >= 0) {
      return current.map((item, index) => (index === optimisticIndex ? next : item));
    }
    const index = current.findIndex((item) => item.id === next.id);
    return index < 0
      ? [...current, next]
      : current.map((item, itemIndex) => (itemIndex === index ? next : item));
  }
  if (event.type === 'turn-completed') {
    return current.map((item) =>
      item.status === 'in-progress'
        ? { ...item, status: 'completed' as const }
        : item
    );
  }
  return current;
}

function assertAccepted(result: CodexSessionOperationResult) {
  if (result.status !== 'accepted' && result.status !== 'completed') {
    throw new Error(
      result.status === 'ambiguous'
        ? 'Sending could not be confirmed. Your message is still here.'
        : 'Codex rejected the message.'
    );
  }
}

function messageFor(error: unknown) {
  return error instanceof Error ? error.message : 'Codex is unavailable.';
}
