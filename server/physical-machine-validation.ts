import type { PhysicalMachineSaveRequest } from '../src/shared/project-space-api';

const physicalMachineIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const maxConnectorInstallationsPerMachine = 100;
const maxConnectorIdLength = 256;

export function isPhysicalMachineId(value: string) {
  return physicalMachineIdPattern.test(value);
}

export function parsePhysicalMachineSaveRequest(
  value: unknown
): PhysicalMachineSaveRequest | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.name !== 'string' ||
    !candidate.name.trim() ||
    candidate.name.trim().length > 80 ||
    (candidate.kind !== 'physical' && candidate.kind !== 'virtual') ||
    (candidate.id !== undefined && (
      typeof candidate.id !== 'string' || !isPhysicalMachineId(candidate.id)
    )) ||
    !Array.isArray(candidate.connectorIds) ||
    candidate.connectorIds.length > maxConnectorInstallationsPerMachine ||
    candidate.connectorIds.some((connectorId) => (
      typeof connectorId !== 'string' ||
      !connectorId.trim() ||
      connectorId.trim().length > maxConnectorIdLength
    ))
  ) {
    return undefined;
  }

  return {
    connectorIds: [
      ...new Set(candidate.connectorIds.map((connectorId) => (connectorId as string).trim()))
    ],
    id: candidate.id as string | undefined,
    kind: candidate.kind,
    name: candidate.name.trim()
  };
}
