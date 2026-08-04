import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';

import type {
  PrototypeReviewLocalContext,
} from '../../../../src/shared/prototype-review-local-api';
import {
  loadNativeReviewContext,
  type NativeReviewConfig,
} from './native-review-api';

export type NativeReviewContextState =
  | { context?: undefined; error?: undefined; state: 'loading' }
  | { context?: undefined; error: string; state: 'unavailable' }
  | {
      context: PrototypeReviewLocalContext;
      error?: undefined;
      state: 'available';
    };

export function useNativeReviewContext(config?: NativeReviewConfig) {
  const [retryKey, setRetryKey] = useState(0);
  const [result, setResult] = useState<NativeReviewContextState>({
    state: 'loading',
  });
  const retry = useCallback(() => {
    setResult({ state: 'loading' });
    setRetryKey((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!config) {
      setResult({
        error: 'Start this prototype with bun run native:review.',
        state: 'unavailable',
      });
      return;
    }
    let active = true;
    let loading = false;
    const controller = new AbortController();
    const load = async () => {
      if (loading || AppState.currentState !== 'active') return;
      loading = true;
      try {
        const context = await loadNativeReviewContext(
          config,
          controller.signal
        );
        if (active) setResult({ context, state: 'available' });
      } catch (error) {
        if (active) {
          setResult({
            error:
              error instanceof Error
                ? error.message
                : 'The local Review server is unavailable.',
            state: 'unavailable',
          });
        }
      } finally {
        loading = false;
      }
    };
    void load();
    const interval = setInterval(load, 5_000);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void load();
    });
    return () => {
      active = false;
      controller.abort();
      clearInterval(interval);
      subscription.remove();
    };
  }, [config?.origin, config?.pullRequestNumber, retryKey]);

  return { ...result, retry };
}
