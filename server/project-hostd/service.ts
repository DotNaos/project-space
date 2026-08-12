import type {
  IssueProjectHostdCredentialInput,
  ProjectHostdCredentialScope,
  ProjectHostdStore,
  ProjectHostdTargetResolver,
  RegisteredRuntimeResolver
} from './contracts';
import { ProjectHostdError } from './contracts';
import { parseObservation } from './validation';

export const projectHostdStaleAfterSeconds = 90;
export const projectHostdObservationRetentionHours = 24;
const maximumObservationAgeMs = 5 * 60_000;
const maximumFutureSkewMs = 5 * 60_000;

export class ProjectHostdService {
  constructor(
    private readonly store: ProjectHostdStore,
    private readonly targets: ProjectHostdTargetResolver,
    private readonly runtimes: RegisteredRuntimeResolver,
    private readonly now = () => new Date()
  ) {}

  async issue(input: IssueProjectHostdCredentialInput) {
    const target = await this.targets.resolve(input);
    if (target !== 'matched') {
      throw new ProjectHostdError(
        'target_conflict',
        target === 'missing' ? 'project-hostd target does not exist.' : 'project-hostd target binding conflicts.'
      );
    }
    return this.store.issue(input);
  }

  authenticate(token: string) {
    return this.store.authenticate(token);
  }

  async append(scope: ProjectHostdCredentialScope, value: unknown) {
    const observation = parseObservation(value);
    if (observation.deviceId !== scope.deviceId ||
      observation.environmentId !== scope.environmentId || observation.hostId !== scope.hostId) {
      throw new ProjectHostdError('authentication_failed', 'project-hostd target identity changed.');
    }
    if (await this.targets.resolve(scope) !== 'matched') {
      throw new ProjectHostdError('target_conflict', 'project-hostd target binding changed.');
    }
    const replayed = await this.store.replay(scope, observation);
    if (replayed) return { replayed: true, snapshot: replayed };
    const receivedAt = this.now();
    const observedAt = Date.parse(observation.observedAt);
    if (observedAt < receivedAt.getTime() - maximumObservationAgeMs ||
      observedAt > receivedAt.getTime() + maximumFutureSkewMs) {
      throw new ProjectHostdError(
        'stale_observation',
        'project-hostd observation is outside the freshness window.'
      );
    }
    if (!await this.runtimes.registered({
      environmentId: scope.environmentId,
      ownerUserId: scope.ownerUserId,
      runtimes: observation.runtimes.map(({ generation, workspaceId }) => ({
        generation, workspaceId
      }))
    })) {
      throw new ProjectHostdError(
        'unregistered_runtime',
        'project-hostd observation contains an unregistered runtime.'
      );
    }
    return this.store.append(scope, observation, receivedAt.toISOString());
  }

  list(ownerUserId: string) {
    return this.store.list(ownerUserId);
  }

  expireStale() {
    const checkedAt = this.now();
    const staleBefore = new Date(
      checkedAt.getTime() - projectHostdStaleAfterSeconds * 1_000
    ).toISOString();
    return this.store.markStale(staleBefore, checkedAt.toISOString());
  }

  pruneExpired() {
    return this.store.pruneExpired(new Date(
      this.now().getTime() - projectHostdObservationRetentionHours * 60 * 60_000
    ).toISOString());
  }
}
