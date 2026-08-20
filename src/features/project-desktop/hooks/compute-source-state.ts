import type { ComputeSourceStatus, ComputeSourceState } from './use-compute-sources-types';

export function createComputeSourceRequestGate() {
  let latestRequest = 0;
  return {
    begin() {
      latestRequest += 1;
      return latestRequest;
    },
    isLatest(request: number) {
      return request === latestRequest;
    }
  };
}

export function computeSourceLoadingState<Result>(current: ComputeSourceState<Result>): ComputeSourceState<Result> {
  return { ...current, error: '', status: current.result ? 'refreshing' : 'loading' };
}

export function computeSourceReadyState<Result>(result: Result): ComputeSourceState<Result> {
  return { error: '', result, status: 'ready' };
}

export function computeSourceErrorState<Result>(current: ComputeSourceState<Result>, error: string): ComputeSourceState<Result> {
  return { ...current, error, status: 'error' };
}
