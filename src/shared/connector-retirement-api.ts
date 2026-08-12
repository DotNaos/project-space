import type { ConnectorResponsibilityId } from './connector-retirement-ledger';

export const connectorRetirementReportVersion = 1 as const;

export interface ConnectorCompatibilityUsageSummary {
  firstSuccessfulUseAt?: string;
  lastSuccessfulUseAt?: string;
  responsibilityId: ConnectorResponsibilityId;
  successfulUseCount: number;
  surface: string;
}

export interface ConnectorRetirementUnresolvedResponsibility {
  reasons: string[];
  responsibilityId: ConnectorResponsibilityId;
}

export interface ConnectorRetirementReport {
  catalogVersion: string;
  checkedAt: string;
  evidence: {
    complete: boolean;
    fresh: boolean;
    observedAt?: string;
  };
  gate: {
    ready: boolean;
    requirements: Record<string, boolean>;
  };
  observation: {
    requiredSeconds: number;
    startedAt?: string;
    zeroUseSince?: string;
  };
  reportVersion: typeof connectorRetirementReportVersion;
  unresolvedResponsibilities: ConnectorRetirementUnresolvedResponsibility[];
  usage: ConnectorCompatibilityUsageSummary[];
}
