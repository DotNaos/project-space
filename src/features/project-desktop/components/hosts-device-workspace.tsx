import { useMemo, useState } from 'react';
import { Button, Chip, Container, Icon, Text } from '@dotnaos/ui/base';
import { useMetricHistory, type MetricSample, type MetricTone } from '@dotnaos/ui/system';
import { MetricBarChart } from '../../../components/ui/metric-bar-chart';
import type { HostsDeviceDescriptor } from './hosts-device-model';
import { OperatingSystem } from './hosts-device-visuals';
import { HostsDeviceSshTerminal } from './hosts-device-ssh-terminal';

type WorkspaceTool = 'desktop' | 'terminal';

function formatRelativeTime(value: string | undefined) {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
  if (minutes < 2) return 'seen just now';
  if (minutes < 60) return `seen ${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `seen ${hours} hours ago`;
  return `seen ${Math.round(hours / 24)} days ago`;
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value < 0) return undefined;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let amount = value;
  let unit = 0;
  while (amount >= 1_024 && unit < units.length - 1) {
    amount /= 1_024;
    unit += 1;
  }
  const rounded = amount >= 10 || unit === 0 ? Math.round(amount) : Math.round(amount * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

function metricSample(value: number | undefined, observedAt: string | undefined): MetricSample | null {
  if (value === undefined || !observedAt) return null;
  const timestamp = Date.parse(observedAt);
  return Number.isFinite(timestamp) ? { timestamp, value } : null;
}

function percentLabel(value: number | undefined) {
  if (value === undefined) return '—';
  const rounded = Math.abs(value) >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded}%`;
}

function usageDetail(total: number | undefined, percent: number | undefined) {
  if (total === undefined || percent === undefined) return 'Not reported';
  const used = formatBytes(total * percent / 100);
  const capacity = formatBytes(total);
  return used && capacity ? `${used} of ${capacity}` : 'Not reported';
}

function DeviceMetric({ detail, label, samples, tone, value }: {
  detail: string;
  label: string;
  samples: readonly MetricSample[];
  tone: MetricTone;
  value: number | undefined;
}) {
  return (
    <section aria-label={`${label} utilization`} className="flex min-h-36 min-w-0 flex-col overflow-hidden rounded-xl bg-bg-1 p-3 ring-1 ring-border/70 sm:min-h-44">
      <span className="text-xs text-text-muted">{label}</span>
      <span className="mt-1 text-xl font-medium text-text">{percentLabel(value)}</span>
      <div className="mt-auto pt-4">
        <MetricBarChart label={`${label} utilization`} max={100} samples={samples} tone={tone} />
      </div>
      <span className="mt-2 truncate text-xs text-text-muted">{detail}</span>
    </section>
  );
}

function TelemetryStatus({ device }: { device: HostsDeviceDescriptor }) {
  const state = device.telemetry?.state;
  if (state === 'available') return <Chip icon="check-circle" label="Live telemetry" size="sm" tone="success" variant="soft" />;
  if (state === 'partial') return <Chip icon="alert-triangle" label="Partial telemetry" size="sm" tone="warning" variant="soft" />;
  if (state === 'stale') return <Chip icon="alert-triangle" label="Stale telemetry" size="sm" tone="warning" variant="soft" />;
  return <Chip icon="circle" label="Telemetry unavailable" size="sm" tone="default" variant="soft" />;
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[minmax(7rem,1fr)_minmax(0,1.4fr)] gap-4 border-b border-border/50 py-2 last:border-0">
      <Text color="muted" size="s" text={label} />
      <span className="truncate text-right text-sm text-text">{value}</span>
    </div>
  );
}

function RemoteDesktopPreview({ device }: { device: HostsDeviceDescriptor }) {
  const [connected, setConnected] = useState(false);

  return (
    <section aria-label="Remote desktop preview" className="flex min-h-96 flex-col overflow-hidden rounded-xl bg-bg-0 ring-1 ring-border/70 sm:min-h-[30rem]">
      <div className="flex items-center justify-between gap-3 bg-bg-2/70 px-4 py-2 text-xs text-text-muted">
        <span className="inline-flex items-center gap-2"><Icon color="muted" name="pointer" size="s" />Remote Desktop preview</span>
        <Chip label={connected ? 'Preview connected' : 'Not connected'} size="sm" tone={connected ? 'success' : 'default'} variant="soft" />
      </div>
      <div className="grid flex-1 place-items-center px-6 py-12 text-center">
        <Container.Stack align="center" gap={3} customize={{
          reason: 'Center the remote desktop preview state without inventing a simulated desktop image.',
          className: 'max-w-sm'
        }}>
          <Icon color={connected ? 'accent' : 'muted'} name="dashboard" size="l" />
          <Text text={connected ? `${device.name} preview session` : 'Remote Desktop is not connected'} variant="heading" level={2} size="s" />
          <Text color="muted" size="s" text={connected
            ? 'This is an interactive preview state. No real screen or input stream is active.'
            : 'Start a mocked session to review the controls without contacting the device.'} />
          <Button
            icon={connected ? 'close' : 'pointer'}
            label={connected ? 'End preview' : 'Start preview session'}
            onPress={() => setConnected((current) => !current)}
            variant={connected ? 'ghost' : 'primary'}
          />
        </Container.Stack>
      </div>
    </section>
  );
}

export function HostsDeviceWorkspace({ device, onBack }: {
  device: HostsDeviceDescriptor;
  onBack(): void;
}) {
  const [tool, setTool] = useState<WorkspaceTool>('terminal');
  const telemetry = device.telemetry;
  const observedAt = telemetry?.observedAt;
  const cpuReading = useMemo(() => metricSample(telemetry?.cpuPercent, observedAt), [observedAt, telemetry?.cpuPercent]);
  const gpuReading = useMemo(() => metricSample(telemetry?.gpuPercent, observedAt), [observedAt, telemetry?.gpuPercent]);
  const memoryReading = useMemo(() => metricSample(telemetry?.memoryPercent, observedAt), [observedAt, telemetry?.memoryPercent]);
  const storageReading = useMemo(() => metricSample(telemetry?.storagePercent, observedAt), [observedAt, telemetry?.storagePercent]);
  const cpuHistory = useMetricHistory(cpuReading, { capacity: 36 });
  const gpuHistory = useMetricHistory(gpuReading, { capacity: 36 });
  const memoryHistory = useMetricHistory(memoryReading, { capacity: 36 });
  const storageHistory = useMetricHistory(storageReading, { capacity: 36 });
  const lastSeen = formatRelativeTime(device.lastSeenAt);
  const telemetrySeen = formatRelativeTime(observedAt);
  const resources = device.resources;

  return (
    <Container.Stack as="section" fullWidth gap={5} padding={1} customize={{
      reason: 'Build a compact device workspace from DotNaos layout and telemetry components.',
      className: 'mx-auto min-h-full w-full max-w-7xl pb-8'
    }}>
      <header className="flex flex-col gap-4 pt-1 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <Button accessibilityLabel="Back to Hosts" icon="arrow-left" onPress={onBack} variant="icon" />
          <div className="min-w-0">
            <span className="[&>h1]:!text-3xl [&>h1]:!leading-tight sm:[&>h1]:!text-4xl">
              <Text text={device.name} variant="heading" level={1} size="l" />
            </span>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-text-muted">
              <Chip
                icon={device.status === 'available' ? 'check-circle' : device.status === 'attention' ? 'alert-triangle' : 'circle'}
                label={device.statusLabel}
                size="sm"
                tone={device.status === 'available' ? 'success' : device.status === 'attention' ? 'warning' : 'default'}
                variant="soft"
              />
              <OperatingSystem value={device.operatingSystem} />
              <span className="text-xs">{device.sourceLabel}</span>
              {lastSeen ? <span className="text-xs">{lastSeen}</span> : null}
              <TelemetryStatus device={device} />
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 pl-11 lg:pl-0">
          <Button icon="terminal" label="Terminal" onPress={() => setTool('terminal')} variant={tool === 'terminal' ? 'primary' : 'ghost'} />
          <Button icon="dashboard" label="Remote Desktop" onPress={() => setTool('desktop')} variant={tool === 'desktop' ? 'primary' : 'ghost'} />
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <DeviceMetric detail={resources ? `${resources.cpuCores} cores` : 'Not reported'} label="CPU" samples={cpuHistory} tone="accent" value={telemetry?.cpuPercent} />
        <DeviceMetric detail={resources?.gpu?.map(({ model }) => model).join(', ') || 'Not reported'} label="GPU" samples={gpuHistory} tone="warning" value={telemetry?.gpuPercent} />
        <DeviceMetric detail={usageDetail(resources?.memoryTotalBytes, telemetry?.memoryPercent)} label="RAM" samples={memoryHistory} tone="success" value={telemetry?.memoryPercent} />
        <DeviceMetric detail={usageDetail(resources?.storageTotalBytes, telemetry?.storagePercent)} label="SSD" samples={storageHistory} tone="muted" value={telemetry?.storagePercent} />
      </div>

      <div className="flex flex-wrap items-center gap-3 text-xs text-text-muted">
        <span>{telemetry
          ? `${telemetry.state === 'stale' ? 'Last' : 'Latest'} project-hostd observation${telemetrySeen ? ` ${telemetrySeen}` : ''}`
          : 'No project-hostd observation is associated with this device.'}</span>
        {device.address ? <span className="font-mono">{device.address}</span> : null}
      </div>

      <div className="flex items-center gap-2" role="tablist" aria-label="Device tools">
        <Button label="SSH terminal" onPress={() => setTool('terminal')} variant={tool === 'terminal' ? 'secondary' : 'ghost'} />
        <Button label="Remote Desktop" onPress={() => setTool('desktop')} variant={tool === 'desktop' ? 'secondary' : 'ghost'} />
      </div>

      {tool === 'terminal' ? <HostsDeviceSshTerminal device={device} /> : <RemoteDesktopPreview device={device} />}

      {resources ? (
        <section aria-label="Reported hardware profile" className="grid gap-x-10 md:grid-cols-2">
          <div>
            <DetailRow label="Processor" value={`${resources.architecture} · ${resources.cpuCores} cores`} />
            <DetailRow label="Memory" value={formatBytes(resources.memoryTotalBytes) ?? '0 B'} />
            <DetailRow label="Identity" value={device.kind === 'codespace' ? 'Codespace' : 'Tailnet device'} />
          </div>
          <div>
            {resources.gpu?.length ? <DetailRow label="Graphics" value={resources.gpu.map(({ model }) => model).join(', ')} /> : null}
            <DetailRow label="Storage" value={formatBytes(resources.storageTotalBytes) ?? '0 B'} />
            <DetailRow label="Data source" value={resources.source === 'hostd' ? 'project-hostd' : resources.source} />
          </div>
        </section>
      ) : null}
    </Container.Stack>
  );
}
