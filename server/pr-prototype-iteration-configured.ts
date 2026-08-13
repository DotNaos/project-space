import type { ProjectSpaceBackend } from '../src/shared/project-space-api';
import type { PullRequestPrototypeIterationRequest } from '../src/shared/pr-prototype-iteration-api';
import type { AvailablePullRequestDevServerSurface } from '../src/shared/pr-preview-test-surfaces-api';
import { retiredPullRequestPrototypeIterationResult } from './pr-prototype-iteration-retirement';

export function createConfiguredPullRequestPrototypeIterationService(
  _backend: ProjectSpaceBackend,
  _userId: string
) {
  return {
    read(
      request: PullRequestPrototypeIterationRequest,
      _live?: AvailablePullRequestDevServerSurface
    ) {
      return Promise.resolve(retiredPullRequestPrototypeIterationResult(request));
    },
    start(request: PullRequestPrototypeIterationRequest) {
      return Promise.resolve(retiredPullRequestPrototypeIterationResult(request));
    }
  };
}
