import { Label, Meter } from '@heroui/react';
import { Cpu, HardDrive, MemoryStick, Microchip } from 'lucide-react';
import { Text } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import type {
  MachineResourceMetric,
  MachineResourceRecord
} from '@/shared/machine-resources-api';

const resourceStateLabels: Record<MachineResourceRecord['state'], string> = {
  failed: 'Unavailable',
  live: 'Live',
  offline: 'Offline',
  partial: 'Partial',
  stale: 'Stale',
  unsupported: 'Unsupported'
};

function roundedPercent(metric: MachineResourceMetric) {
  const value = metric.utilizationPercent;
  return metric.state === 'available' && typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(100, Math.round(value)))
    : undefined;
}

function metricValue(metric: MachineResourceMetric) {
  const percent = roundedPercent(metric);
  if (percent !== undefined) return `${percent}%`;
  if (metric.state === 'unsupported') return 'Not supported';
  return 'Unavailable';
}

function formatBytes(value: number) {
  const gibibytes = value / 1024 ** 3;
  return `${gibibytes >= 10 ? gibibytes.toFixed(0) : gibibytes.toFixed(1)} GB`;
}

function metricDetail(metric: MachineResourceMetric) {
  if (
    metric.state === 'available' &&
    Number.isFinite(metric.usedBytes) &&
    Number.isFinite(metric.totalBytes)
  ) {
    return `${formatBytes(metric.usedBytes!)} of ${formatBytes(metric.totalBytes!)}`;
  }
  return metric.message;
}

function meterColor(value: number | undefined) {
  if (value === undefined) return 'default' as const;
  if (value >= 90) return 'danger' as const;
  if (value >= 75) return 'warning' as const;
  return 'accent' as const;
}

export function MachineResourceSummary({
  className,
  resources
}: {
  className?: string;
  resources?: MachineResourceRecord;
}) {
  if (!resources) {
    return (
      <span className={cn('inline-flex text-[11px] text-neutral-600', className)}>
        Checking resources…
      </span>
    );
  }

  const metrics = [
    ['CPU', resources.metrics.cpu],
    ['RAM', resources.metrics.memory],
    ['Disk', resources.metrics.disk]
  ] as const;
  const gpu = roundedPercent(resources.metrics.gpu) === undefined
    ? []
    : [['GPU', resources.metrics.gpu] as const];
  const visible = [...metrics, ...gpu].filter(([, metric]) => roundedPercent(metric) !== undefined);

  if (visible.length === 0) {
    return (
      <span className={cn('inline-flex text-[11px] text-neutral-600', className)}>
        Resources {resourceStateLabels[resources.state].toLowerCase()}
      </span>
    );
  }

  return (
    <span
      className={cn('flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]', className)}
      aria-label={`Resources ${resourceStateLabels[resources.state]}`}
    >
      {visible.map(([label, metric], index) => (
        <span
          key={label}
          className={cn(
            'inline-flex items-center gap-1 whitespace-nowrap text-neutral-500',
            index > 1 && 'hidden sm:inline-flex'
          )}
        >
          <span>{label}</span>
          <span className="tabular-nums text-neutral-300">{metricValue(metric)}</span>
        </span>
      ))}
      {resources.state !== 'live' ? (
        <span
          className={cn(
            'whitespace-nowrap',
            resources.state === 'partial' || resources.state === 'stale'
              ? 'text-amber-300'
              : 'text-neutral-600'
          )}
        >
          {resourceStateLabels[resources.state]}
        </span>
      ) : null}
    </span>
  );
}

function ResourceMeter({
  icon: Icon,
  label,
  metric
}: {
  icon: typeof Cpu;
  label: string;
  metric: MachineResourceMetric;
}) {
  const value = roundedPercent(metric);
  const detail = metricDetail(metric);

  if (value === undefined) {
    return (
      <div className="grid gap-1.5 border-b border-neutral-900/70 py-3 last:border-b-0">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <span className="inline-flex min-w-0 items-center gap-2 text-neutral-400">
            <Icon className="size-4 shrink-0" />
            <Text className="truncate text-sm font-medium">{label}</Text>
          </span>
          <Text className="shrink-0 text-xs text-neutral-600">{metricValue(metric)}</Text>
        </div>
        {detail ? <Text className="pl-6 text-xs text-neutral-600">{detail}</Text> : null}
      </div>
    );
  }

  return (
    <Meter
      aria-label={`${label} utilization`}
      className="border-b border-neutral-900/70 py-3 last:border-b-0"
      color={meterColor(value)}
      maxValue={100}
      minValue={0}
      size="sm"
      value={value}
    >
      <Label className="inline-flex min-w-0 items-center gap-2 text-neutral-400">
        <Icon className="size-4 shrink-0" />
        <span className="truncate">{label}</span>
      </Label>
      <Meter.Output>{value}%</Meter.Output>
      <Meter.Track>
        <Meter.Fill />
      </Meter.Track>
      {detail ? <Text className="mt-1 block pl-6 text-xs text-neutral-600">{detail}</Text> : null}
    </Meter>
  );
}

export function MachineResourcePanel({
  resources
}: {
  resources?: MachineResourceRecord;
}) {
  if (!resources) {
    return (
      <div className="py-5">
        <Text className="block text-sm text-neutral-500">Checking current resource usage…</Text>
      </div>
    );
  }

  return (
    <>
      <div className="mb-1 flex min-w-0 items-center justify-between gap-3">
        <Text className="text-sm font-semibold text-neutral-100">Resources</Text>
        <Text
          className={cn(
            'text-xs',
            resources.state === 'live' ? 'text-emerald-300' : 'text-neutral-500'
          )}
        >
          {resourceStateLabels[resources.state]}
        </Text>
      </div>
      <ResourceMeter icon={Cpu} label="CPU" metric={resources.metrics.cpu} />
      <ResourceMeter icon={MemoryStick} label="Memory" metric={resources.metrics.memory} />
      <ResourceMeter icon={HardDrive} label="Disk" metric={resources.metrics.disk} />
      <ResourceMeter icon={Microchip} label="GPU" metric={resources.metrics.gpu} />
      <Text className="mt-2 block text-xs text-neutral-600">
        {resources.sampledAt
          ? `Measured ${new Date(resources.sampledAt).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit'
            })}`
          : 'No measurement available.'}
      </Text>
    </>
  );
}
