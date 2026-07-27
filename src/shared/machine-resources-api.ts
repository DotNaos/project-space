import type { ConnectorEnvironmentRecord } from './project-space-api';

export const MACHINE_RESOURCES_API_VERSION = 1 as const;
export const MACHINE_RESOURCES_STALE_AFTER_MS = 15_000;

export type MachineResourceMetricState = 'available' | 'failed' | 'unsupported';

export interface MachineResourceMetric {
  message?: string;
  state: MachineResourceMetricState;
  totalBytes?: number;
  usedBytes?: number;
  utilizationPercent?: number;
}

export interface MachineResourceSnapshot {
  apiVersion: typeof MACHINE_RESOURCES_API_VERSION;
  connectorId: string;
  metrics: {
    cpu: MachineResourceMetric;
    disk: MachineResourceMetric;
    gpu: MachineResourceMetric;
    memory: MachineResourceMetric;
  };
  sampledAt: string;
}

export type MachineResourceAvailability =
  | 'failed'
  | 'live'
  | 'offline'
  | 'partial'
  | 'stale'
  | 'unsupported';

export interface MachineResourceRecord extends Omit<MachineResourceSnapshot, 'sampledAt'> {
  context: {
    id: string;
    label?: string;
  };
  environment?: ConnectorEnvironmentRecord;
  executionScopeId?: string;
  machineId: string;
  machineName: string;
  physicalMachineId?: string;
  physicalMachineName?: string;
  receivedAt?: string;
  sampledAt?: string;
  state: MachineResourceAvailability;
}

export interface MachineResourcesResult {
  checkedAt: string;
  machines: MachineResourceRecord[];
}

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finitePercentage(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

function finiteBytes(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isMachineResourceMetric(value: unknown): value is MachineResourceMetric {
  if (!isRecord(value) || !['available', 'failed', 'unsupported'].includes(String(value.state))) {
    return false;
  }
  const allowed = new Set(['message', 'state', 'totalBytes', 'usedBytes', 'utilizationPercent']);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  if (value.message !== undefined && typeof value.message !== 'string') return false;
  const totalBytes = value.totalBytes;
  const usedBytes = value.usedBytes;
  const utilizationPercent = value.utilizationPercent;
  if (totalBytes !== undefined && !finiteBytes(totalBytes)) return false;
  if (usedBytes !== undefined && !finiteBytes(usedBytes)) return false;
  if (utilizationPercent !== undefined && !finitePercentage(utilizationPercent)) {
    return false;
  }
  const hasTotalBytes = totalBytes !== undefined;
  const hasUsedBytes = usedBytes !== undefined;
  if (hasTotalBytes !== hasUsedBytes) return false;
  if (
    typeof totalBytes === 'number' &&
    typeof usedBytes === 'number' &&
    (totalBytes <= 0 || usedBytes > totalBytes)
  ) {
    return false;
  }
  if (value.state !== 'available') {
    return totalBytes === undefined &&
      usedBytes === undefined &&
      utilizationPercent === undefined;
  }
  return utilizationPercent !== undefined ||
    (typeof totalBytes === 'number' &&
      typeof usedBytes === 'number' &&
      usedBytes <= totalBytes);
}

export function isMachineResourceSnapshot(value: unknown): value is MachineResourceSnapshot {
  if (!isRecord(value)) return false;
  const allowed = new Set(['apiVersion', 'connectorId', 'metrics', 'sampledAt']);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  if (value.apiVersion !== MACHINE_RESOURCES_API_VERSION) return false;
  if (typeof value.connectorId !== 'string' || !identifier.test(value.connectorId)) return false;
  const sampledAt = value.sampledAt;
  const metrics = value.metrics;
  if (typeof sampledAt !== 'string' || !Number.isFinite(Date.parse(sampledAt)) ||
      !isRecord(metrics)) {
    return false;
  }
  const metricKeys = ['cpu', 'disk', 'gpu', 'memory'] as const;
  return Object.keys(metrics).length === metricKeys.length &&
    metricKeys.every((key) => isMachineResourceMetric(metrics[key]));
}
