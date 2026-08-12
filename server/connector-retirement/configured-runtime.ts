import { connectorResponsibilityIds } from '../../src/shared/connector-retirement-ledger';
import { getConnectorCompatibilityUsageStore } from '../local-database-store';
import {
  isConnectorCompatibilitySurface,
  type ConnectorCompatibilitySurface,
  type ConnectorReplacementProof,
  type ConnectorRetirementConfig
} from './contracts';
import { ConnectorRetirementService } from './service';

let configuredService: ConnectorRetirementService | null | undefined;
let configuredServicePromise: Promise<ConnectorRetirementService | null> | undefined;
const ownerWrites = new Map<string, Promise<void>>();
const pendingInvalidOwners = new Set<string>();

export function configuredConnectorRetirementConfig(
  environment: NodeJS.ProcessEnv = process.env
): ConnectorRetirementConfig {
  return {
    deprecationSunsetAt: installerSunset(environment),
    failureContractReleased:
      environment.PROJECT_SPACE_CONNECTOR_RETIREMENT_FAILURE_CONTRACT_RELEASED === 'true',
    legacyGlobalCredentialDisabled: !environment.PROJECT_CONNECTOR_REGISTRATION_TOKEN?.trim(),
    maximumEvidenceAgeSeconds: boundedInteger(
      environment.PROJECT_SPACE_CONNECTOR_RETIREMENT_MAX_EVIDENCE_AGE_SECONDS,
      900,
      60,
      86_400
    ),
    observationStartedAt: exactTimestamp(
      environment.PROJECT_SPACE_CONNECTOR_RETIREMENT_WINDOW_STARTED_AT
    ),
    replacementProofs: replacementProofs(
      environment.PROJECT_SPACE_CONNECTOR_RETIREMENT_PROOFS_JSON
    ),
    replacementProofsVerified: false,
    requiredObservationSeconds: boundedInteger(
      environment.PROJECT_SPACE_CONNECTOR_RETIREMENT_WINDOW_SECONDS,
      30 * 24 * 60 * 60,
      24 * 60 * 60,
      180 * 24 * 60 * 60
    )
  };
}

export async function configuredConnectorRetirementService() {
  if (configuredService !== undefined) return configuredService;
  if (configuredServicePromise) return configuredServicePromise;
  configuredServicePromise = initializeConfiguredService();
  try {
    return await configuredServicePromise;
  } finally {
    configuredServicePromise = undefined;
  }
}

async function initializeConfiguredService() {
  const store = await getConnectorCompatibilityUsageStore();
  if (!store) {
    configuredService = null;
    return configuredService;
  }
  const service = new ConnectorRetirementService(store, configuredConnectorRetirementConfig());
  for (const ownerUserId of pendingInvalidOwners) service.invalidate(ownerUserId);
  pendingInvalidOwners.clear();
  await service.startMonitoring();
  configuredService = service;
  return configuredService;
}

export function recordSuccessfulConnectorCompatibilityUse(
  ownerUserId: string | undefined,
  surface: ConnectorCompatibilitySurface,
  completedAt = new Date().toISOString()
) {
  if (!ownerUserId || !isConnectorCompatibilitySurface(surface)) return Promise.resolve(false);
  const result = record(ownerUserId, surface, completedAt);
  const tail = result.then(() => undefined, () => undefined);
  ownerWrites.set(ownerUserId, tail);
  void tail.finally(() => {
    if (ownerWrites.get(ownerUserId) === tail) ownerWrites.delete(ownerUserId);
  });
  return result;
}

export async function waitForConnectorCompatibilityWrites(ownerUserId: string) {
  await ownerWrites.get(ownerUserId);
}

export async function closeConfiguredConnectorRetirementService() {
  await Promise.all([...ownerWrites.values()]);
  await configuredServicePromise;
  await configuredService?.close();
  configuredService = undefined;
}

async function record(
  ownerUserId: string,
  surface: ConnectorCompatibilitySurface,
  completedAt: string
) {
  try {
    const service = await configuredConnectorRetirementService();
    return service?.record({
      authorized: true,
      completedAt,
      outcome: 'succeeded',
      ownerUserId,
      replayed: false,
      surface
    }) ?? false;
  } catch {
    if (configuredService) configuredService.invalidate(ownerUserId);
    else pendingInvalidOwners.add(ownerUserId);
    return false;
  }
}

function boundedInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
) {
  if (!raw || !/^[1-9][0-9]*$/.test(raw)) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

function exactTimestamp(raw: string | undefined) {
  if (!raw) return undefined;
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === raw ? raw : undefined;
}

function replacementProofs(raw: string | undefined) {
  if (!raw || raw.length > 32_768) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const record = value as Record<string, unknown>;
    const proofs: Partial<Record<typeof connectorResponsibilityIds[number], ConnectorReplacementProof>> = {};
    for (const id of connectorResponsibilityIds) {
      const proof = record[id];
      if (!proof || typeof proof !== 'object' || Array.isArray(proof)) continue;
      const fields = proof as Record<string, unknown>;
      if (Object.keys(fields).sort().join(',') !==
          'deployedRevision,rollbackDrillAt,runtimeProofRef' ||
          typeof fields.deployedRevision !== 'string' ||
          typeof fields.rollbackDrillAt !== 'string' ||
          typeof fields.runtimeProofRef !== 'string') continue;
      proofs[id] = {
        deployedRevision: fields.deployedRevision,
        rollbackDrillAt: fields.rollbackDrillAt,
        runtimeProofRef: fields.runtimeProofRef
      };
    }
    return proofs;
  } catch {
    return {};
  }
}

function installerSunset(environment: NodeJS.ProcessEnv) {
  const raw = environment.PROJECT_SPACE_CONNECTOR_COMPATIBILITY_INSTALL_UNTIL_EPOCH?.trim();
  if (!raw || !/^[1-9][0-9]{9}$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? new Date(value * 1000).toISOString() : undefined;
}
