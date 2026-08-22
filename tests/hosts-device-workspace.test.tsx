import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HostsDeviceWorkspace } from '../src/features/project-desktop/components/hosts-device-workspace';

describe('Hosts device workspace', () => {
  test('keeps real telemetry separate from client-owned SSH and mocked desktop control', () => {
    const html = renderToStaticMarkup(createElement(HostsDeviceWorkspace, {
      device: {
        address: '100.80.135.9',
        id: 'device:os-macbook',
        kind: 'tailnet',
        name: 'os-macbook',
        operatingSystem: 'macOS',
        resources: {
          architecture: 'arm64', cpuCores: 10, cpuUsedPercent: 14,
          gpu: [{ model: 'Apple M4 GPU', usedPercent: 22 }],
          memoryAvailableBytes: 8 * 1_024 ** 3, memoryTotalBytes: 16 * 1_024 ** 3,
          operatingSystem: 'macOS', reportedAt: '2026-08-22T12:00:00.000Z', source: 'hostd',
          storageAvailableBytes: 100 * 1_024 ** 3, storageTotalBytes: 200 * 1_024 ** 3
        },
        sourceLabel: 'Tailnet device',
        status: 'available',
        statusLabel: 'Online',
        telemetry: {
          cpuPercent: 14, gpuPercent: 22, memoryPercent: 50,
          observedAt: '2026-08-22T12:00:00.000Z', source: 'project-hostd',
          state: 'available', storagePercent: 50
        }
      },
      onBack() {}
    }));

    expect(html).toContain('os-macbook');
    expect(html).toContain('100.80.135.9');
    expect(html).toContain('Live telemetry');
    expect(html).toContain('project-hostd observation');
    expect(html).toContain('14%');
    expect(html).toContain('Apple M4 GPU');
    expect(html).toContain('SSH username');
    expect(html).toContain('No SSH connection is active');
    expect(html).toContain('Trusts a new device key once');
    expect(html).not.toContain('Mock SSH terminal');
    expect(html).toContain('Remote Desktop');
    expect(html).toContain('grid-cols-2');
    expect(html).toContain('min-h-36');
  });
});
