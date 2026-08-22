import type { MetricSample, MetricTone } from '@dotnaos/ui/system';

export interface MetricBarChartProps {
  capacity?: number;
  height?: number;
  label: string;
  max?: number;
  min?: number;
  samples: readonly MetricSample[];
  tone?: MetricTone;
}

const toneColors: Record<MetricTone, string> = {
  accent: 'var(--color-accent)',
  danger: 'var(--color-danger)',
  muted: 'var(--color-text-muted)',
  success: 'var(--color-success)',
  warning: 'var(--color-warning)'
};

function finiteRange(min: number, max: number) {
  return Number.isFinite(min) && Number.isFinite(max) && max > min ? max - min : 1;
}

function metricLabel(label: string, samples: readonly MetricSample[]) {
  const latest = samples.at(-1)?.value;
  return latest === undefined ? `${label}: no readings` : `${label}: ${Math.round(latest * 10) / 10}%`;
}

export function MetricBarChart({
  capacity = 36,
  height = 48,
  label,
  max = 100,
  min = 0,
  samples,
  tone = 'accent'
}: MetricBarChartProps) {
  const slots = Math.max(1, Math.floor(capacity));
  const visible = samples.slice(-slots);
  const gap = slots === 1 ? 0 : 0.8;
  const barWidth = Math.max(0.5, (100 - gap * (slots - 1)) / slots);
  const start = slots - visible.length;
  const range = finiteRange(min, max);

  return (
    <div
      aria-label={metricLabel(label, visible)}
      className="w-full overflow-hidden"
      data-ui-component="MetricBarChart"
      data-ui-component-source="story"
      data-ui-source-file="src/components/ui/metric-bar-chart.tsx"
      role="img"
    >
      <svg aria-hidden="true" className="block w-full" height={height} preserveAspectRatio="none" viewBox={`0 0 100 ${height}`}>
        {visible.map((sample, index) => {
          const fraction = Math.min(1, Math.max(0, (sample.value - min) / range));
          const barHeight = Math.max(1, fraction * height);
          return (
            <rect
              fill={toneColors[tone]}
              height={barHeight}
              key={`${sample.timestamp}:${index}`}
              opacity={0.5 + ((index + 1) / visible.length) * 0.5}
              rx={Math.min(1, barWidth / 2)}
              width={barWidth}
              x={(start + index) * (barWidth + gap)}
              y={height - barHeight}
            />
          );
        })}
      </svg>
    </div>
  );
}
