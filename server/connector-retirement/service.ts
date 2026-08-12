import {
  connectorRetirementReportVersion,
  type ConnectorRetirementReport
} from '../../src/shared/connector-retirement-api';
import {
  connectorResponsibilityIds,
  connectorRetirementLedger
} from '../../src/shared/connector-retirement-ledger';
import {
  connectorCompatibilityCatalogIsComplete,
  connectorCompatibilityCatalogVersion,
  connectorCompatibilityUnattributedCatalogVersion,
  connectorCompatibilitySurfaces,
  isConnectorCompatibilitySurface,
  type ConnectorCompatibilityUsageStore,
  type ConnectorRetirementConfig
} from './contracts';
import { randomUUID } from 'node:crypto';

export class ConnectorRetirementService {
  private readonly invalidOwners = new Set<string>();
  private readonly initializedOwners = new Set<string>();
  private readonly monitorTimers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly ownerTails = new Map<string, Promise<void>>();
  private monitoring = false;

  constructor(
    private readonly store: ConnectorCompatibilityUsageStore,
    private readonly config: ConnectorRetirementConfig,
    private readonly now: () => Date = () => new Date(),
    private readonly sessionId = `connector-retirement-${randomUUID()}`
  ) {}

  async checkpoint(ownerUserId: string) {
    return this.withOwner(ownerUserId, async () => {
      await this.ensureRecorderSession(ownerUserId);
      const checkedAt = this.now().toISOString();
      const resetContinuity = this.invalidOwners.has(ownerUserId);
      await this.store.checkpoint(
        ownerUserId,
        this.sessionId,
        this.evidenceCatalogVersion,
        checkedAt,
        this.config.maximumEvidenceAgeSeconds,
        resetContinuity
      );
      this.invalidOwners.delete(ownerUserId);
      return checkedAt;
    });
  }

  invalidate(ownerUserId: string) {
    this.invalidOwners.add(ownerUserId);
  }

  async record(input: {
    authorized: boolean;
    completedAt?: string;
    outcome: 'failed' | 'succeeded';
    ownerUserId?: string;
    replayed: boolean;
    surface: unknown;
  }) {
    if (!input.authorized || input.outcome !== 'succeeded' || input.replayed ||
        !input.ownerUserId || !isConnectorCompatibilitySurface(input.surface)) {
      return false;
    }
    const completedAt = input.completedAt ?? this.now().toISOString();
    if (!validTimestamp(completedAt)) return false;
    const ownerUserId = input.ownerUserId;
    const surface = input.surface;
    return this.withOwner(ownerUserId, async () => {
      await this.ensureRecorderSession(ownerUserId);
      if (this.invalidOwners.has(ownerUserId)) {
        await this.store.checkpoint(
          ownerUserId,
          this.sessionId,
          this.evidenceCatalogVersion,
          this.now().toISOString(),
          this.config.maximumEvidenceAgeSeconds,
          true
        );
        this.invalidOwners.delete(ownerUserId);
      }
      await this.store.recordSuccess(
        ownerUserId,
        this.sessionId,
        this.evidenceCatalogVersion,
        surface,
        completedAt,
        this.config.maximumEvidenceAgeSeconds
      );
      return true;
    });
  }

  async report(ownerUserId: string): Promise<ConnectorRetirementReport> {
    return this.withOwner(ownerUserId, async () => {
      await this.ensureRecorderSession(ownerUserId);
      return this.buildReport(ownerUserId);
    });
  }

  async close() {
    this.monitoring = false;
    for (const timer of this.monitorTimers.values()) clearInterval(timer);
    this.monitorTimers.clear();
    await Promise.all([...this.ownerTails.values()]);
    // A recorder failure must survive a clean process restart. Leaving the
    // session active makes the next recorder reset continuity fail closed.
    if (this.invalidOwners.size === 0) {
      await this.store.closeRecorderSession(this.sessionId, this.now().toISOString());
    }
  }

  async startMonitoring() {
    if (this.monitoring) return;
    this.monitoring = true;
    const owners = await this.store.listObservedOwners();
    await Promise.all(owners.map((ownerUserId) => this.checkpoint(ownerUserId)));
  }

  private async buildReport(ownerUserId: string): Promise<ConnectorRetirementReport> {
    const checkedAt = this.now();
    const snapshot = await this.store.list(ownerUserId);
    const observationStartedAt = timestamp(this.config.observationStartedAt);
    const continuousSince = timestamp(snapshot.observation?.continuousSince);
    const observedAt = timestamp(snapshot.observation?.observedAt);
    const evidenceComplete = Boolean(
      connectorCompatibilityCatalogIsComplete() &&
      snapshot.observation?.catalogVersion === connectorCompatibilityCatalogVersion &&
      continuousSince && observedAt && continuousSince <= observedAt
    );
    const evidenceFresh = Boolean(
      observedAt && observedAt <= checkedAt &&
      checkedAt.getTime() - observedAt.getTime() <= this.config.maximumEvidenceAgeSeconds * 1000
    );
    const usage = connectorCompatibilitySurfaces.map((surface) => {
      const row = snapshot.usage.find((entry) => entry.surface === surface.id);
      return {
        ...(row?.firstSuccessfulUseAt ? { firstSuccessfulUseAt: row.firstSuccessfulUseAt } : {}),
        ...(row?.lastSuccessfulUseAt ? { lastSuccessfulUseAt: row.lastSuccessfulUseAt } : {}),
        responsibilityId: surface.responsibilityId,
        successfulUseCount: row?.successfulUseCount ?? 0,
        surface: surface.id
      };
    });
    const lastUse = usage.reduce<Date | undefined>((latest, row) => {
      const value = timestamp(row.lastSuccessfulUseAt);
      return value && (!latest || value > latest) ? value : latest;
    }, undefined);
    const deprecationSunset = timestamp(this.config.deprecationSunsetAt);
    const zeroUseSince = latestTimestamp(
      continuousSince,
      observationStartedAt,
      deprecationSunset,
      lastUse
    );
    const zeroUseWindowComplete = Boolean(
      zeroUseSince && evidenceComplete && evidenceFresh &&
      checkedAt.getTime() - zeroUseSince.getTime() >= this.config.requiredObservationSeconds * 1000
    );
    const deprecationWindowConfigured = Boolean(
      deprecationSunset && deprecationSunset <= checkedAt && observationStartedAt
    );
    const allReplacementsDeployed = this.config.replacementProofsVerified &&
      connectorResponsibilityIds.every((id) =>
      validRevision(this.config.replacementProofs[id]?.deployedRevision)
    );
    const runtimeProofComplete = this.config.replacementProofsVerified &&
      connectorResponsibilityIds.every((id) =>
      validProofReference(this.config.replacementProofs[id]?.runtimeProofRef)
    );
    const rollbackDrillComplete = this.config.replacementProofsVerified &&
      connectorResponsibilityIds.every((id) =>
      validPastTimestamp(this.config.replacementProofs[id]?.rollbackDrillAt, checkedAt)
    );
    const requirements = {
      all_replacements_deployed: allReplacementsDeployed,
      compatibility_usage_classified: connectorCompatibilityCatalogIsComplete() && evidenceComplete,
      deprecation_window_configured: deprecationWindowConfigured,
      legacy_failure_contract_released: this.config.failureContractReleased,
      owner_attribution_complete: this.config.legacyGlobalCredentialDisabled,
      rollback_drill_complete: rollbackDrillComplete,
      runtime_proof_complete: runtimeProofComplete,
      zero_successful_legacy_use_for_full_window: zeroUseWindowComplete
    };
    return {
      catalogVersion: connectorCompatibilityCatalogVersion,
      checkedAt: checkedAt.toISOString(),
      evidence: {
        complete: evidenceComplete,
        fresh: evidenceFresh,
        ...(observedAt ? { observedAt: observedAt.toISOString() } : {})
      },
      gate: {
        ready: Object.values(requirements).every(Boolean),
        requirements
      },
      observation: {
        requiredSeconds: this.config.requiredObservationSeconds,
        ...(zeroUseSince ? { startedAt: zeroUseSince.toISOString() } : {}),
        ...(zeroUseSince ? { zeroUseSince: zeroUseSince.toISOString() } : {})
      },
      reportVersion: connectorRetirementReportVersion,
      unresolvedResponsibilities: connectorRetirementLedger.flatMap(({ id }) => {
        const proof = this.config.replacementProofs[id];
        const reasons = [
          ...(!this.config.replacementProofsVerified ? ['replacement_proof_unverified'] : []),
          ...(!validRevision(proof?.deployedRevision) ? ['replacement_not_deployed'] : []),
          ...(!validProofReference(proof?.runtimeProofRef) ? ['runtime_proof_incomplete'] : []),
          ...(!validPastTimestamp(proof?.rollbackDrillAt, checkedAt)
            ? ['rollback_not_ready']
            : []),
          ...(!evidenceComplete || !evidenceFresh ? ['usage_evidence_incomplete'] : []),
          ...(!zeroUseWindowComplete ? ['zero_use_window_incomplete'] : [])
        ];
        return reasons.length ? [{ reasons, responsibilityId: id }] : [];
      }),
      usage
    };
  }

  private async ensureRecorderSession(ownerUserId: string) {
    if (this.initializedOwners.has(ownerUserId)) return;
    await this.store.beginRecorderSession(
      ownerUserId,
      this.sessionId,
      this.evidenceCatalogVersion,
      this.now().toISOString(),
      this.config.maximumEvidenceAgeSeconds
    );
    this.initializedOwners.add(ownerUserId);
    this.monitorOwner(ownerUserId);
  }

  private get evidenceCatalogVersion() {
    return this.config.legacyGlobalCredentialDisabled
      ? connectorCompatibilityCatalogVersion
      : connectorCompatibilityUnattributedCatalogVersion;
  }

  private monitorOwner(ownerUserId: string) {
    if (!this.monitoring || this.monitorTimers.has(ownerUserId)) return;
    const intervalMs = Math.max(
      30_000,
      Math.floor(this.config.maximumEvidenceAgeSeconds * 1000 / 2)
    );
    const timer = setInterval(() => {
      void this.checkpoint(ownerUserId).catch(() => this.invalidate(ownerUserId));
    }, intervalMs);
    timer.unref?.();
    this.monitorTimers.set(ownerUserId, timer);
  }

  private withOwner<Result>(ownerUserId: string, operation: () => Promise<Result>) {
    const previous = this.ownerTails.get(ownerUserId) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    const tail = current.then(() => undefined, () => undefined);
    this.ownerTails.set(ownerUserId, tail);
    void tail.finally(() => {
      if (this.ownerTails.get(ownerUserId) === tail) this.ownerTails.delete(ownerUserId);
    });
    return current;
  }
}

function latestTimestamp(...values: Array<Date | undefined>) {
  return values.reduce<Date | undefined>((latest, value) =>
    value && (!latest || value > latest) ? value : latest, undefined
  );
}

function validTimestamp(value: string) {
  const parsed = timestamp(value);
  return Boolean(parsed && parsed.toISOString() === value);
}

function validRevision(value: string | undefined) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

function validPastTimestamp(value: string | undefined, checkedAt: Date) {
  const parsed = timestamp(value);
  return Boolean(parsed && parsed <= checkedAt && parsed.toISOString() === value);
}

function validProofReference(value: string | undefined) {
  if (!value || value.length > 512) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '';
  } catch {
    return false;
  }
}

function timestamp(value: string | undefined) {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : undefined;
}
