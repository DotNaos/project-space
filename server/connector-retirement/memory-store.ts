import {
  type ConnectorCompatibilityObservation,
  type ConnectorCompatibilitySurface,
  type ConnectorCompatibilityUsageRow,
  type ConnectorCompatibilityUsageStore
} from './contracts';

export class MemoryConnectorCompatibilityUsageStore
implements ConnectorCompatibilityUsageStore {
  private readonly observations = new Map<string, ConnectorCompatibilityObservation>();
  private readonly recorderSessions = new Map<string, { id: string; state: 'active' | 'clean' }>();
  private readonly rows = new Map<string, ConnectorCompatibilityUsageRow>();

  async beginRecorderSession(
    ownerUserId: string,
    sessionId: string,
    catalogVersion: string,
    startedAt: string,
    maximumGapSeconds: number
  ) {
    const current = this.observations.get(ownerUserId);
    const recorder = this.recorderSessions.get(ownerUserId);
    const continuous = Boolean(
      current && recorder?.state === 'clean' &&
      current.catalogVersion === catalogVersion &&
      Date.parse(startedAt) - Date.parse(current.observedAt) <= maximumGapSeconds * 1000
    );
    this.observations.set(ownerUserId, {
      catalogVersion,
      continuousSince: continuous ? current!.continuousSince : startedAt,
      observedAt: startedAt
    });
    this.recorderSessions.set(ownerUserId, { id: sessionId, state: 'active' });
  }

  async checkpoint(
    ownerUserId: string,
    sessionId: string,
    catalogVersion: string,
    observedAt: string,
    maximumGapSeconds: number,
    resetContinuity = false
  ) {
    this.requireActiveSession(ownerUserId, sessionId);
    const current = this.observations.get(ownerUserId);
    if (!current || current.observedAt < observedAt) {
      const continuous = Boolean(
        !resetContinuity && current?.catalogVersion === catalogVersion &&
        Date.parse(observedAt) - Date.parse(current.observedAt) <= maximumGapSeconds * 1000
      );
      this.observations.set(ownerUserId, {
        catalogVersion,
        continuousSince: continuous ? current!.continuousSince : observedAt,
        observedAt
      });
    }
  }

  async list(ownerUserId: string) {
    return {
      observation: this.observations.get(ownerUserId),
      usage: [...this.rows.entries()]
        .filter(([key]) => key.startsWith(`${ownerUserId}\0`))
        .map(([, row]) => ({ ...row }))
        .sort((left, right) => left.surface.localeCompare(right.surface))
    };
  }

  async listObservedOwners() {
    return [...this.observations.keys()].sort();
  }

  async recordSuccess(
    ownerUserId: string,
    sessionId: string,
    catalogVersion: string,
    surface: ConnectorCompatibilitySurface,
    completedAt: string,
    maximumGapSeconds: number
  ) {
    this.requireActiveSession(ownerUserId, sessionId);
    const key = `${ownerUserId}\0${surface}`;
    const current = this.rows.get(key);
    this.rows.set(key, current ? {
      firstSuccessfulUseAt: current.firstSuccessfulUseAt < completedAt
        ? current.firstSuccessfulUseAt
        : completedAt,
      lastSuccessfulUseAt: current.lastSuccessfulUseAt > completedAt
        ? current.lastSuccessfulUseAt
        : completedAt,
      successfulUseCount: current.successfulUseCount + 1,
      surface
    } : {
      firstSuccessfulUseAt: completedAt,
      lastSuccessfulUseAt: completedAt,
      successfulUseCount: 1,
      surface
    });
    await this.checkpoint(
      ownerUserId,
      sessionId,
      catalogVersion,
      completedAt,
      maximumGapSeconds
    );
  }

  async closeRecorderSession(sessionId: string, _closedAt: string) {
    for (const [ownerUserId, session] of this.recorderSessions) {
      if (session.id === sessionId && session.state === 'active') {
        this.recorderSessions.set(ownerUserId, { ...session, state: 'clean' });
      }
    }
  }

  private requireActiveSession(ownerUserId: string, sessionId: string) {
    const session = this.recorderSessions.get(ownerUserId);
    if (session?.id !== sessionId || session.state !== 'active') {
      throw new Error('Connector retirement recorder session changed.');
    }
  }
}
