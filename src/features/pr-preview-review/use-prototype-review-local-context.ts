import { useCallback, useEffect, useState } from 'react';

import type { PrototypeReviewLocalContext } from '@/shared/prototype-review-local-api';

type PrototypeReviewLocalContextState =
  | { context?: undefined; state: 'disabled' | 'loading' | 'unavailable' }
  | { context: PrototypeReviewLocalContext; state: 'available' };

export type PrototypeReviewLocalContextResult =
  PrototypeReviewLocalContextState & { retry(): void };

export function usePrototypeReviewLocalContext(options: {
  enabled: boolean;
  pullRequestNumber?: number;
  repositoryFullName?: string;
}) {
  const [result, setResult] = useState<PrototypeReviewLocalContextState>(
    options.enabled ? { state: 'loading' } : { state: 'disabled' }
  );
  const [retryKey, setRetryKey] = useState(0);
  const retry = useCallback(() => {
    setResult((current) =>
      current.state === 'disabled' ? current : { state: 'loading' }
    );
    setRetryKey((current) => current + 1);
  }, []);

  useEffect(() => {
    if (!options.enabled) {
      setResult({ state: 'disabled' });
      return;
    }
    setResult((current) =>
      current.state === 'available' ? current : { state: 'loading' }
    );
    let active = true;
    let loading = false;
    const load = async (allowHidden = false) => {
      if (loading || (!allowHidden && document.hidden)) return;
      loading = true;
      try {
        const query = new URLSearchParams();
        if (options.repositoryFullName) {
          query.set('repository', options.repositoryFullName);
        }
        if (options.pullRequestNumber) {
          query.set('pr', String(options.pullRequestNumber));
        }
        const response = await fetch(
          `/api/prototype-review/local-context${query.size ? `?${query}` : ''}`,
          { headers: { Accept: 'application/json' } }
        );
        if (!response.ok) throw new Error('Local context request failed.');
        const value: unknown = await response.json();
        if (active) {
          setResult(
            isLocalContext(value)
              ? { context: value, state: 'available' }
              : { state: 'unavailable' }
          );
        }
      } catch {
        if (active) {
          setResult((current) =>
            current.state === 'available' ? current : { state: 'unavailable' }
          );
        }
      } finally {
        loading = false;
      }
    };
    void load(true);
    const interval = window.setInterval(() => void load(), 5_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [
    options.enabled,
    options.pullRequestNumber,
    options.repositoryFullName,
    retryKey
  ]);

  return { ...result, retry };
}

function isLocalContext(value: unknown): value is PrototypeReviewLocalContext {
  if (!value || typeof value !== 'object') return false;
  const context = value as Partial<PrototypeReviewLocalContext>;
  if (
    typeof context.checkedAt !== 'string' ||
    !Number.isFinite(Date.parse(context.checkedAt)) ||
    !context.checkout ||
    !context.codex
  ) return false;
  const checkout = context.checkout;
  const codex = context.codex;
  const validCheckout = checkout.state === 'available'
    ? /^[0-9a-f]{40}$/.test(checkout.headSha) &&
      /^[^/\s]+\/[^/\s]+$/.test(checkout.repositoryFullName)
    : checkout.state === 'unavailable' && typeof checkout.reason === 'string';
  const validCodex = codex.state === 'available'
    ? Boolean(codex.machineId && codex.machineName && codex.threadId)
    : codex.state === 'unavailable' && typeof codex.reason === 'string';
  return validCheckout && validCodex;
}
