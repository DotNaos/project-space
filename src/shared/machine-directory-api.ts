export const MACHINE_DIRECTORY_SCHEMA_VERSION = 1 as const;

export type TailscaleReachabilityState =
  | 'reachable'
  | 'unreachable'
  | 'stale'
  | 'unknown'
  | 'unsupported';

export type SshAvailabilityState =
  | 'available'
  | 'unavailable'
  | 'checking'
  | 'unknown'
  | 'unsupported';

export type ConnectorReadinessState =
  | 'ready'
  | 'degraded'
  | 'unavailable'
  | 'unknown';

export type CodexAppServerState =
  | 'available'
  | 'unavailable'
  | 'stale'
  | 'unknown'
  | 'unsupported';

export type MachineEnrollmentState = 'enrolled' | 'unknown';

export interface MachineSignal<State extends string> {
  checkedAt?: string;
  lastSeenAt?: string;
  message?: string;
  state: State;
}

export interface MachineDirectoryConnector {
  environment?: string;
  id: string;
  lastSeenAt?: string;
  name: string;
  state: 'ready' | 'unavailable' | 'unknown';
}

export interface MachineDirectoryMachine {
  codexAppServer: MachineSignal<CodexAppServerState>;
  connector: MachineSignal<ConnectorReadinessState> & {
    installations: MachineDirectoryConnector[];
  };
  enrollment: MachineSignal<MachineEnrollmentState>;
  id: string;
  name: string;
  platform: {
    architectures: string[];
    operatingSystems: string[];
  };
  ssh: MachineSignal<SshAvailabilityState>;
  tailscale: MachineSignal<TailscaleReachabilityState>;
}

export interface MachineDirectoryFailure {
  machineId: string;
  message: string;
  source: 'identity' | 'probe';
}

export interface MachineDirectoryResult {
  checkedAt: string;
  failures: MachineDirectoryFailure[];
  machines: MachineDirectoryMachine[];
  schemaVersion: typeof MACHINE_DIRECTORY_SCHEMA_VERSION;
}

export interface MachineSshConnectionResult {
  machine: {
    id: string;
    name: string;
  };
  schemaVersion: typeof MACHINE_DIRECTORY_SCHEMA_VERSION;
  target: string;
}

export interface CodexThreadCatalogHost {
  checkedAt: string;
  connectorId: string;
  inventoryState: 'live' | 'stale' | 'unavailable';
  machineId: string;
  machineName: string;
  message?: string;
}

export interface CodexThreadCatalogRecord {
  archived: boolean;
  connectorId: string;
  cwd?: string;
  id: string;
  inventoryState: 'live' | 'stale';
  machine: {
    id: string;
    name: string;
  };
  project?: string;
  repository?: string;
  state: string;
  title: string;
  updatedAt: string;
}

export interface CodexThreadCatalogResult {
  checkedAt: string;
  hosts: CodexThreadCatalogHost[];
  partial: boolean;
  schemaVersion: typeof MACHINE_DIRECTORY_SCHEMA_VERSION;
  threads: CodexThreadCatalogRecord[];
}
