export type ComputeSourceStatus = 'error' | 'loading' | 'ready' | 'refreshing';

export interface ComputeSourceState<Result> {
  error: string;
  result?: Result;
  status: ComputeSourceStatus;
}
