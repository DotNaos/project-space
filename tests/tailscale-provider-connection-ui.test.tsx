import { describe, expect, mock, test } from 'bun:test';
import { createElement, type ElementType, type ReactNode } from 'react';

type Connection = {
  connectionState: 'connected' | 'legacy' | 'not_connected' | 'reauthorization_required';
  requiredScope: 'devices:core:read';
  source: 'tailscale_oauth_api' | 'temporary_vps_local_status' | 'not_connected';
  verifiedAt?: string;
};

type Client = {
  connectTailscaleProvider(request: { clientId: string; clientSecret: string }): Promise<Connection>;
  getTailscaleInventory(refresh?: boolean): Promise<{
    devices: never[];
    provider: { refreshState: 'available' | 'not_checked'; source: Connection['source'] };
    schemaVersion: 1;
  }>;
  getTailscaleProviderConnection(): Promise<Connection>;
  revokeTailscaleProviderConnection(): Promise<Connection>;
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
    connectTailscaleProvider: (request: { clientId: string; clientSecret: string }) => client.connectTailscaleProvider(request),
    getTailscaleInventory: (refresh?: boolean) => client.getTailscaleInventory(refresh),
    getTailscaleProviderConnection: () => client.getTailscaleProviderConnection(),
    revokeTailscaleProviderConnection: () => client.revokeTailscaleProviderConnection(),
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
  return {
    Button: element('button'), Input: element('input'),
    Label: element('label'), Modal, TextField: element('div')
  };
});
mock.module('lucide-react', () => ({
  Network: () => null,
  RefreshCw: () => null
}));

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

function inventory(source: Connection['source']) {
  return { devices: [], provider: { refreshState: 'available' as const, source }, schemaVersion: 1 as const };
}

describe('Tailscale provider connection UI', () => {
  test('labels the temporary source without presenting it as an OAuth connection', async () => {
    resetHooks();
    client = {
      connectTailscaleProvider: async () => { throw new Error('not used'); },
      getTailscaleInventory: async () => inventory('temporary_vps_local_status'),
      getTailscaleProviderConnection: async () => ({ connectionState: 'legacy', requiredScope: 'devices:core:read', source: 'temporary_vps_local_status' }),
      revokeTailscaleProviderConnection: async () => { throw new Error('not used'); },
      setTailscaleDeviceClassification: async () => ({ classification: 'unclassified', id: 'device', revision: 0 })
    };

    open();
    await settle();
    const output = text(render());

    expect(output).toContain('Temporary VPS local Tailscale');
    expect(output).toContain('not a Tailscale API connection for this account');
    expect(output).toContain('Connect this account’s Tailscale API');
    expect(output).toContain('devices:core:read');
    expect(output).not.toContain('Connected to Tailscale API');
    expect(output).not.toContain('Disconnect');
  });

  test('submits account credentials once and removes the secret field after a successful connection', async () => {
    resetHooks();
    const requests: Array<{ clientId: string; clientSecret: string }> = [];
    client = {
      connectTailscaleProvider: async (request) => {
        requests.push(request);
        return { connectionState: 'connected', requiredScope: 'devices:core:read', source: 'tailscale_oauth_api', verifiedAt: '2026-08-14T12:00:00.000Z' };
      },
      getTailscaleInventory: async () => inventory('tailscale_oauth_api'),
      getTailscaleProviderConnection: async () => ({ connectionState: 'not_connected', requiredScope: 'devices:core:read', source: 'not_connected' }),
      revokeTailscaleProviderConnection: async () => ({ connectionState: 'not_connected', requiredScope: 'devices:core:read', source: 'not_connected' }),
      setTailscaleDeviceClassification: async () => ({ classification: 'unclassified', id: 'device', revision: 0 })
    };

    open();
    await settle();
    const fields = nodes(render()).filter((node) => typeof node.props.onChange === 'function');
    (fields[0]?.props.onChange as (value: string) => void)('client-id-test');
    (fields[1]?.props.onChange as (value: string) => void)('not-a-real-secret');
    const form = nodes(render()).find((node) => typeof node.props.onSubmit === 'function');
    (form?.props.onSubmit as (event: { preventDefault(): void }) => void)({ preventDefault() {} });
    await settle();
    const output = text(render());

    expect(requests).toEqual([{ clientId: 'client-id-test', clientSecret: 'not-a-real-secret' }]);
    expect(output).toContain('Connected to Tailscale API');
    expect(output).not.toContain('Client secret');
    expect(output).not.toContain('not-a-real-secret');
  });

  test('disconnect calls the local connection endpoint and explains its revocation boundary', async () => {
    resetHooks();
    let disconnects = 0;
    client = {
      connectTailscaleProvider: async () => { throw new Error('not used'); },
      getTailscaleInventory: async () => inventory('tailscale_oauth_api'),
      getTailscaleProviderConnection: async () => ({ connectionState: 'connected', requiredScope: 'devices:core:read', source: 'tailscale_oauth_api' }),
      revokeTailscaleProviderConnection: async () => {
        disconnects += 1;
        return { connectionState: 'not_connected', requiredScope: 'devices:core:read', source: 'not_connected' };
      },
      setTailscaleDeviceClassification: async () => ({ classification: 'unclassified', id: 'device', revision: 0 })
    };

    open();
    await settle();
    const connected = render();
    expect(text(connected)).toContain('It does not revoke the Tailscale OAuth client');
    const disconnect = nodes(connected).find((node) => typeof node.props.onPress === 'function'
      && text(node.props.children) === 'Disconnect');
    (disconnect?.props.onPress as (() => void))();
    await settle();

    expect(disconnects).toBe(1);
  });

  test('shows a generic error without exposing a provider response', async () => {
    resetHooks();
    client = {
      connectTailscaleProvider: async () => { throw new Error('not used'); },
      getTailscaleInventory: async () => { throw new Error('upstream token=never-display'); },
      getTailscaleProviderConnection: async () => { throw new Error('upstream token=never-display'); },
      revokeTailscaleProviderConnection: async () => { throw new Error('not used'); },
      setTailscaleDeviceClassification: async () => ({ classification: 'unclassified', id: 'device', revision: 0 })
    };

    open();
    await settle();
    const output = text(render());

    expect(output).toContain('The saved Tailscale connection could not be checked. Try again later.');
    expect(output).not.toContain('upstream token=never-display');
  });
});
