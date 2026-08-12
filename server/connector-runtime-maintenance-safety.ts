export type ConnectorRuntimeMaintenanceBlocker =
  | {
      kind: 'codex-runtime';
      state: 'uncertain';
    }
  | {
      kind: 'codex-turn';
      state: 'active';
      threadId: string;
      turnId?: string;
    }
  | {
      kind: 'codex-turn';
      state: 'starting';
      threadId: string;
    }
  | {
      kind: 'codex-request';
      requestId: number | string;
      state: 'waiting-for-approval' | 'waiting-for-user-input';
      threadId: string;
      turnId?: string;
    }
  | {
      kind: 'codex-operation';
      operationId: string;
      state: 'uncertain';
    }
  | {
      count: number;
      kind: 'connector-mutation';
      scope: 'workspace' | 'worktree';
    }
  | {
      count: number;
      kind: 'connector-activity';
      scope: ConnectorRuntimeMaintenanceActivity;
    }
  | {
      kind: 'runtime-maintenance';
      state: 'admitted';
    };

export type ConnectorRuntimeMaintenanceActivity =
  | 'codex'
  | 'codex-chat'
  | 'daemon'
  | 'dev-server'
  | 'filesystem'
  | 'project-cli'
  | 'terminal'
  | 'workspace'
  | 'worktree';

export interface ConnectorRuntimeMaintenanceLease {
  release(): void;
}

export class ConnectorRuntimeMaintenanceBusyError extends Error {
  readonly code = 'busy';

  constructor() {
    super('Connector runtime maintenance is already in progress.');
    this.name = 'ConnectorRuntimeMaintenanceBusyError';
  }
}

export type ConnectorRuntimeMaintenanceSafetyResult =
  | {
      blockers: readonly ConnectorRuntimeMaintenanceBlocker[];
      certainty: 'known';
      lease?: ConnectorRuntimeMaintenanceLease;
    }
  | { certainty: 'uncertain' };

export type ConnectorRuntimeMaintenanceSafetyCheck =
  () => ConnectorRuntimeMaintenanceSafetyResult;

interface ConnectorRuntimeMaintenanceBlockerProvider {
  maintenanceBlockers(): readonly ConnectorRuntimeMaintenanceBlocker[];
}

export class ConnectorRuntimeMaintenanceAdmission {
  private readonly activities = new Map<ConnectorRuntimeMaintenanceActivity, number>();
  private maintenanceToken?: symbol;

  tryBeginActivity(
    scope: ConnectorRuntimeMaintenanceActivity
  ): ConnectorRuntimeMaintenanceLease | undefined {
    if (this.maintenanceToken) return undefined;
    this.activities.set(scope, (this.activities.get(scope) ?? 0) + 1);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        const count = this.activities.get(scope) ?? 0;
        if (count <= 1) this.activities.delete(scope);
        else this.activities.set(scope, count - 1);
      }
    };
  }

  tryBeginMaintenance(
    inspect: () => readonly ConnectorRuntimeMaintenanceBlocker[]
  ): ConnectorRuntimeMaintenanceSafetyResult {
    if (this.maintenanceToken) {
      return {
        blockers: [{ kind: 'runtime-maintenance', state: 'admitted' }],
        certainty: 'known'
      };
    }
    let blockers: readonly ConnectorRuntimeMaintenanceBlocker[];
    try {
      blockers = inspect();
      if (!Array.isArray(blockers)) return { certainty: 'uncertain' };
    } catch {
      return { certainty: 'uncertain' };
    }
    const activityBlockers = [...this.activities.entries()].map(([scope, count]) => ({
      count, kind: 'connector-activity' as const, scope
    }));
    if (blockers.length > 0 || activityBlockers.length > 0) {
      return { blockers: [...activityBlockers, ...blockers], certainty: 'known' };
    }
    const token = Symbol('connector-runtime-maintenance');
    this.maintenanceToken = token;
    let released = false;
    return {
      blockers: [],
      certainty: 'known',
      lease: {
        release: () => {
          if (released) return;
          released = true;
          if (this.maintenanceToken === token) this.maintenanceToken = undefined;
        }
      }
    };
  }
}

export function createConnectorRuntimeMaintenanceSafetyCheck(
  admission: ConnectorRuntimeMaintenanceAdmission,
  ...providers: readonly ConnectorRuntimeMaintenanceBlockerProvider[]
): ConnectorRuntimeMaintenanceSafetyCheck {
  return () => admission.tryBeginMaintenance(
    () => providers.flatMap((provider) => [...provider.maintenanceBlockers()])
  );
}
