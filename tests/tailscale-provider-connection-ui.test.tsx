import { describe, expect, mock, test } from 'bun:test';
import { createElement, type ElementType, type ReactNode } from 'react';

type Source = 'tailscale_oauth_api' | 'temporary_vps_local_status' | 'not_connected';
type State =
  | 'authentication_error' | 'configured' | 'configuration_error' | 'connected'
  | 'legacy' | 'not_configured' | 'scope_insufficient' | 'unavailable';

type Client = {
  getTailscaleInventory(): Promise<{
    devices: never[];
    provider: { connectionState: State; refreshState: 'available' | 'unavailable'; source: Source };
    schemaVersion: 1;
  }>;
  setTailscaleDeviceClassification(): Promise<{ classification: 'unclassified'; id: string; revision: number }>;
};

let client: Client;
let state: unknown[] = [];
let stateIndex = 0;
let effectIndex = 0;
let effectDependencies: unknown[][] = [];

mock.module('react', () => ({
  useCallback: <T extends (...args: never[]) => unknown>(callback: T) => callback,
  useEffect: (effect: () => void | (() => void), dependencies: unknown[]) => {
    const index = effectIndex++;
    const previous = effectDependencies[index];
    const changed = !previous || previous.length !== dependencies.length
      || previous.some((value, dependencyIndex) => value !== dependencies[dependencyIndex]);
    effectDependencies[index] = dependencies;
    if (changed) effect();
  },
  useState: <T,>(initial: T) => {
    const index = stateIndex++;
    if (state[index] === undefined) state[index] = initial;
    return [state[index] as T, (next: T | ((current: T) => T)) => {
      state[index] = typeof next === 'function'
        ? (next as (current: T) => T)(state[index] as T)
        : next;
    }] as const;
  }
}));
const jsx = (type: unknown, props: Record<string, unknown> | null) => ({ type, props: props ?? {} });
mock.module('react/jsx-runtime', () => ({ Fragment: Symbol.for('react.fragment'), jsx, jsxs: jsx }));
mock.module('react/jsx-dev-runtime', () => ({ Fragment: Symbol.for('react.fragment'), jsxDEV: jsx }));

mock.module('@/api/project-space-client', () => ({
  projectSpaceClient: {
    getTailscaleInventory: () => client.getTailscaleInventory(),
    setTailscaleDeviceClassification: () => client.setTailscaleDeviceClassification()
  }
}));
mock.module('@/shared/tailscale-inventory-api', () => ({
  tailscaleDeviceClassifications: [
    'unclassified', 'environment', 'deployment_destination', 'console_endpoint', 'ignored'
  ]
}));

function element(tag: ElementType) {
  return ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
    createElement(tag, props, children);
}

mock.module('@/app/dotnaos-ui', () => ({
  Button: element('button'),
  Chip: element('span'),
  ListBox: element('div'),
  ListBoxItem: element('div'),
  Select: Object.assign(element('div'), {
    Indicator: element('span'), Popover: element('div'), Trigger: element('button')
  }),
  Text: element('span')
}));
mock.module('@heroui/react', () => {
  const Modal = Object.assign(({ children, isOpen }: { children?: ReactNode; isOpen?: boolean }) => (
    isOpen ? createElement('div', undefined, children) : null
  ), {
    Backdrop: element('div'), Body: element('div'), CloseTrigger: element('button'),
    Container: element('div'), Dialog: element('div'), Footer: element('div'),
    Header: element('div'), Heading: element('h2')
  });
  return { Button: element('button'), Modal };
});
mock.module('lucide-react', () => ({ Network: () => null, RefreshCw: () => null }));

const { TailscaleDeviceClassification } = await import('../src/features/project-desktop/components/tailscale-device-classification');

function resetHooks() {
  state = [];
  stateIndex = 0;
  effectIndex = 0;
  effectDependencies = [];
}

function render() {
  stateIndex = 0;
  effectIndex = 0;
  return TailscaleDeviceClassification();
}

function nodes(value: unknown): Array<{ props: Record<string, unknown>; type: unknown }> {
  if (!value || typeof value !== 'object') return [];
  const elementValue = value as { props?: Record<string, unknown>; type?: unknown };
  const own = elementValue.props ? [{ props: elementValue.props, type: elementValue.type }] : [];
  const children = elementValue.props?.children;
  return own.concat(Array.isArray(children) ? children.flatMap(nodes) : nodes(children));
}

function text(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (!value || typeof value !== 'object') return '';
  const children = (value as { props?: { children?: unknown } }).props?.children;
  return Array.isArray(children) ? children.map(text).join('') : text(children);
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

function open() {
  render();
  state[0] = true;
  render();
}

function inventory(connectionState: State, source: Source = 'tailscale_oauth_api') {
  return {
    devices: [],
    provider: { connectionState, refreshState: 'available' as const, source },
    schemaVersion: 1 as const
  };
}

describe('Tailscale deployment connection UI', () => {
  test('shows deployment-owned configuration without credential or lifecycle controls', async () => {
    resetHooks();
    client = {
      getTailscaleInventory: async () => inventory('configured'),
      setTailscaleDeviceClassification: async () => ({ classification: 'unclassified', id: 'device', revision: 0 })
    };

    open();
    await settle();
    const output = text(render());
    const renderedNodes = nodes(render());

    expect(output).toContain('Tailscale is configured for this deployment');
    expect(output).toContain('Refresh devices to verify the deployment credential and load current Tailnet evidence.');
    expect(output).not.toMatch(/Client ID|Client secret|Connect Tailscale API|Disconnect/);
    expect(renderedNodes.some((node) => node.type === 'input' || typeof node.props.onSubmit === 'function')).toBe(false);
  });

  test('labels the temporary source without presenting it as an account connection', async () => {
    resetHooks();
    client = {
      getTailscaleInventory: async () => inventory('legacy', 'temporary_vps_local_status'),
      setTailscaleDeviceClassification: async () => ({ classification: 'unclassified', id: 'device', revision: 0 })
    };

    open();
    await settle();
    const output = text(render());

    expect(output).toContain('Temporary VPS local Tailscale');
    expect(output).toContain('temporary server-local source remains active');
    expect(output).not.toMatch(/Client ID|Client secret|Connect Tailscale API|Disconnect/);
  });

  test('sanitizes every deployment credential failure state', async () => {
    for (const stateValue of ['configuration_error', 'authentication_error', 'scope_insufficient', 'unavailable'] as const) {
      resetHooks();
      client = {
        getTailscaleInventory: async () => inventory(stateValue),
        setTailscaleDeviceClassification: async () => ({ classification: 'unclassified', id: 'device', revision: 0 })
      };

      open();
      await settle();
      const output = text(render());
      expect(output).toMatch(/Tailscale credential could not be used|Tailscale is temporarily unavailable|devices:core:read/);
      expect(output).not.toMatch(/Client ID|Client secret|Connect Tailscale API|Disconnect|token=|secret=/i);
    }
  });

  test('shows a generic inventory error without exposing an upstream response', async () => {
    resetHooks();
    client = {
      getTailscaleInventory: async () => { throw new Error('upstream token=never-display'); },
      setTailscaleDeviceClassification: async () => ({ classification: 'unclassified', id: 'device', revision: 0 })
    };

    open();
    await settle();
    const output = text(render());

    expect(output).toContain('Tailnet inventory could not be loaded.');
    expect(output).not.toContain('upstream token=never-display');
  });
});
