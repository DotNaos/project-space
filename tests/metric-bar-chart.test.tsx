import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MetricBarChart } from '../src/components/ui/metric-bar-chart';

describe('MetricBarChart', () => {
  test('renders a bounded accessible bar history without a line graph', () => {
    const html = renderToStaticMarkup(createElement(MetricBarChart, {
      capacity: 3,
      label: 'CPU utilization',
      samples: [
        { timestamp: 1, value: 10 },
        { timestamp: 2, value: 25 },
        { timestamp: 3, value: 40 },
        { timestamp: 4, value: 55 }
      ],
      tone: 'accent'
    }));

    expect(html).toContain('aria-label="CPU utilization: 55%"');
    expect(html.match(/<rect/g)).toHaveLength(3);
    expect(html).not.toContain('polyline');
    expect(html).toContain('var(--color-accent)');
  });
});
