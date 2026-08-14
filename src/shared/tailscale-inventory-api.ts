export const tailscaleInventoryApiVersion = 1;

export const tailscaleDeviceClassifications = [
  'unclassified', 'environment', 'deployment_destination', 'console_endpoint', 'ignored'
] as const;
export type TailscaleDeviceClassification = typeof tailscaleDeviceClassifications[number];

export type TailscaleProviderRefreshState =
  | 'available' | 'partial' | 'unavailable' | 'not_checked';
export type TailscaleProviderNetworkState = 'online' | 'offline' | 'stale' | 'unknown';

export interface TailscaleInventoryDevice {
  addresses: string[];
  classification: TailscaleDeviceClassification;
  id: string;
  name?: string;
  network: {
    checkedAt: string;
    freshUntil: string;
    lastSeenAt?: string;
    state: TailscaleProviderNetworkState;
  };
  os?: string;
  revision: number;
  tags: string[];
}

export interface TailscaleInventoryResult {
  devices: TailscaleInventoryDevice[];
  provider: {
    errorCount?: number;
    reasonCode?: string;
    refreshState: TailscaleProviderRefreshState;
  };
  schemaVersion: typeof tailscaleInventoryApiVersion;
}

export interface TailscaleClassificationRequest {
  classification: TailscaleDeviceClassification;
  expectedRevision: number;
}
