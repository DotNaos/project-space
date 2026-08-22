import type {
  ProjectCliComputeInventory,
  ProjectCliEnvironmentInstance,
  ProjectCliInventoryResourceSummary
} from '@/shared/compute-inventory-cli-api';
import type { CodespaceRow, TailnetDeviceRow, TailnetDeviceStatus } from './compute-host-inventory-model';

export type HostsDeviceKind = 'codespace' | 'tailnet';

export interface HostsDeviceRoute {
  id: string;
  kind: HostsDeviceKind;
}

export interface HostsDeviceDescriptor extends HostsDeviceRoute {
  address?: string;
  lastSeenAt?: string;
  name: string;
  operatingSystem?: string;
  resources?: ProjectCliInventoryResourceSummary;
  sourceLabel: string;
  status: TailnetDeviceStatus;
  statusLabel: string;
  telemetry?: HostsDeviceTelemetry;
}

export interface HostsDeviceTelemetry {
  cpuPercent?: number;
  gpuPercent?: number;
  memoryPercent?: number;
  observedAt: string;
  source: 'project-hostd';
  state: 'available' | 'partial' | 'stale';
  storagePercent?: number;
}

const deviceRoutePrefix = '/settings/devices';

export function hostsDeviceRoute(kind: HostsDeviceKind, id: string) {
  return `${deviceRoutePrefix}/${kind}/${encodeURIComponent(id)}`;
}

export function parseHostsDeviceRoute(pathname: string): HostsDeviceRoute | undefined {
  const normalized = pathname.replace(/\/+$/, '');
  if (!normalized.startsWith(`${deviceRoutePrefix}/`)) return undefined;

  const [rawKind, rawId, ...rest] = normalized.slice(deviceRoutePrefix.length + 1).split('/');
  if (rest.length > 0 || (rawKind !== 'tailnet' && rawKind !== 'codespace') || !rawId) {
    return undefined;
  }

  try {
    return { id: decodeURIComponent(rawId), kind: rawKind };
  } catch {
    return undefined;
  }
}

function boundedPercent(value: number | undefined) {
  return value !== undefined && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : undefined;
}

function usedPercent(total: number, available: number | undefined) {
  if (!Number.isFinite(total) || total <= 0 || available === undefined ||
    !Number.isFinite(available) || available < 0 || available > total) return undefined;
  return Math.round(((total - available) / total) * 1_000) / 10;
}

export function hostdTelemetry(
  environment: ProjectCliEnvironmentInstance | undefined
): HostsDeviceTelemetry | undefined {
  const resources = environment?.resources;
  if (!environment || !resources || resources.source !== 'hostd' ||
    (environment.hostd.state !== 'available' && environment.hostd.state !== 'stale')) return undefined;
  const partial = new Set(environment.hostd.partialMetrics ?? []);
  const cpuPercent = partial.has('cpu') ? undefined : boundedPercent(resources.cpuUsedPercent);
  const gpuPercent = partial.has('gpu')
    ? undefined
    : boundedPercent(resources.gpu?.find(({ usedPercent }) => usedPercent !== undefined)?.usedPercent);
  const memoryPercent = partial.has('memory')
    ? undefined
    : usedPercent(resources.memoryTotalBytes, resources.memoryAvailableBytes);
  const storagePercent = partial.has('storage')
    ? undefined
    : usedPercent(resources.storageTotalBytes, resources.storageAvailableBytes);
  return {
    ...(cpuPercent === undefined ? {} : { cpuPercent }),
    ...(gpuPercent === undefined ? {} : { gpuPercent }),
    ...(memoryPercent === undefined ? {} : { memoryPercent }),
    observedAt: resources.reportedAt,
    source: 'project-hostd',
    state: environment.hostd.state === 'stale'
      ? 'stale'
      : partial.size > 0 ? 'partial' : 'available',
    ...(storagePercent === undefined ? {} : { storagePercent })
  };
}

function newestHostdEnvironment(
  environments: readonly ProjectCliEnvironmentInstance[],
  hostId: string | undefined
) {
  if (!hostId) return undefined;
  return environments
    .filter((environment) => environment.hostId === hostId && environment.resources?.source === 'hostd')
    .sort((left, right) => Date.parse(right.resources?.reportedAt ?? '') -
      Date.parse(left.resources?.reportedAt ?? ''))[0];
}

export function tailnetDeviceDescriptor(
  row: TailnetDeviceRow,
  inventory?: Pick<ProjectCliComputeInventory, 'environmentInstances' | 'hosts'>
): HostsDeviceDescriptor {
  const environment = newestHostdEnvironment(
    inventory?.environmentInstances ?? [],
    row.device.hostId
  );
  const resources = environment?.resources ?? inventory?.hosts.find(({ id }) => id === row.device.hostId)?.resources;
  const telemetry = hostdTelemetry(environment);
  return {
    address: row.addresses[0],
    id: row.id,
    kind: 'tailnet',
    lastSeenAt: row.device.network.lastSeenAt,
    name: row.name,
    operatingSystem: row.operatingSystem,
    ...(resources ? { resources } : {}),
    sourceLabel: 'Tailnet device',
    status: row.status,
    statusLabel: row.statusLabel,
    ...(telemetry ? { telemetry } : {})
  };
}

export function codespaceDeviceDescriptor(row: CodespaceRow): HostsDeviceDescriptor {
  const telemetry = hostdTelemetry(row.environment);
  return {
    id: row.id,
    kind: 'codespace',
    lastSeenAt: row.environment.hostd.lastSeenAt,
    name: row.name,
    operatingSystem: row.operatingSystem,
    ...(row.environment.resources ? { resources: row.environment.resources } : {}),
    sourceLabel: 'GitHub Codespace',
    status: 'unknown',
    statusLabel: 'Provider managed',
    ...(telemetry ? { telemetry } : {})
  };
}
