import { AsyncLocalStorage } from 'node:async_hooks';

export interface GitHubCatalogRequestTiming {
  authMs: number;
  requestStartedAt: number;
}

const timingContext = new AsyncLocalStorage<GitHubCatalogRequestTiming>();

export function runWithGitHubCatalogRequestTiming<T>(timing: GitHubCatalogRequestTiming, callback: () => T) {
  return timingContext.run(timing, callback);
}

export function getGitHubCatalogRequestTiming() {
  return timingContext.getStore();
}
