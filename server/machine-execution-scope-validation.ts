import type { MachineExecutionScopeSaveRequest } from '../src/shared/project-space-api';

const scopeIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const maxConnectorInstancesPerScope = 100;
const maxMachineIdLength = 256;

export function isMachineExecutionScopeId(value: string) {
  return scopeIdPattern.test(value);
}

export function parseMachineExecutionScopeSaveRequest(
  value: unknown
): MachineExecutionScopeSaveRequest | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.name !== 'string' ||
    !candidate.name.trim() ||
    candidate.name.trim().length > 80 ||
    (candidate.id !== undefined && (
      typeof candidate.id !== 'string' || !isMachineExecutionScopeId(candidate.id)
    )) ||
    !Array.isArray(candidate.machineIds) ||
    candidate.machineIds.length === 0 ||
    candidate.machineIds.length > maxConnectorInstancesPerScope ||
    candidate.machineIds.some((machineId) => (
      typeof machineId !== 'string' ||
      !machineId.trim() ||
      machineId.trim().length > maxMachineIdLength
    ))
  ) {
    return undefined;
  }

  return {
    id: candidate.id as string | undefined,
    machineIds: [...new Set(candidate.machineIds.map((machineId) => (machineId as string).trim()))],
    name: candidate.name.trim()
  };
}
