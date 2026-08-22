import { describe, expect, test } from 'bun:test';
import {
  hostdTelemetry,
  hostsDeviceRoute,
  parseHostsDeviceRoute
} from '../src/features/project-desktop/components/hosts-device-model';
import type { ProjectCliEnvironmentInstance } from '../src/shared/compute-inventory-cli-api';

describe('Hosts device routes', () => {
  test('round-trips Tailnet and Codespace identifiers', () => {
    const tailnet = hostsDeviceRoute('tailnet', 'device:os-macbook/tail5bb1d7.ts.net');
    const codespace = hostsDeviceRoute('codespace', 'github:project-space-572');

    expect(parseHostsDeviceRoute(tailnet)).toEqual({
      id: 'device:os-macbook/tail5bb1d7.ts.net',
      kind: 'tailnet'
    });
    expect(parseHostsDeviceRoute(codespace)).toEqual({
      id: 'github:project-space-572',
      kind: 'codespace'
    });
  });

  test('rejects incomplete and unrelated paths', () => {
    expect(parseHostsDeviceRoute('/settings')).toBeUndefined();
    expect(parseHostsDeviceRoute('/settings/devices/host/example')).toBeUndefined();
    expect(parseHostsDeviceRoute('/settings/devices/tailnet')).toBeUndefined();
  });

  test('derives only real utilization values from a fresh project-hostd observation', () => {
    const environment = {
      hostd: {
        health: 'healthy',
        hostdVersion: '0.1.0',
        lastSeenAt: '2026-08-22T12:00:01.000Z',
        observedAt: '2026-08-22T12:00:00.000Z',
        partialMetrics: [],
        protocolVersion: 1,
        state: 'available'
      },
      resources: {
        architecture: 'arm64',
        cpuCores: 10,
        cpuUsedPercent: 12.5,
        gpu: [{ model: 'Apple M4 GPU', usedPercent: 42 }],
        memoryAvailableBytes: 8_000,
        memoryTotalBytes: 16_000,
        operatingSystem: 'macOS',
        reportedAt: '2026-08-22T12:00:00.000Z',
        source: 'hostd',
        storageAvailableBytes: 25_000,
        storageTotalBytes: 100_000
      }
    } as ProjectCliEnvironmentInstance;

    expect(hostdTelemetry(environment)).toEqual({
      cpuPercent: 12.5,
      gpuPercent: 42,
      memoryPercent: 50,
      observedAt: '2026-08-22T12:00:00.000Z',
      source: 'project-hostd',
      state: 'available',
      storagePercent: 75
    });
  });

  test('omits partial metrics instead of fabricating readings', () => {
    const environment = {
      hostd: { partialMetrics: ['gpu', 'memory'], state: 'available' },
      resources: {
        architecture: 'amd64', cpuCores: 4, cpuUsedPercent: 8,
        memoryTotalBytes: 16_000, operatingSystem: 'Linux',
        reportedAt: '2026-08-22T12:00:00.000Z', source: 'hostd', storageTotalBytes: 100_000
      }
    } as ProjectCliEnvironmentInstance;

    expect(hostdTelemetry(environment)).toEqual({
      cpuPercent: 8,
      observedAt: '2026-08-22T12:00:00.000Z',
      source: 'project-hostd',
      state: 'partial'
    });
  });
});
