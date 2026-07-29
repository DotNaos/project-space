import type { CodexSessionListResult } from '../../src/shared/codex-sessions-api';
import {
  MACHINE_DIRECTORY_SCHEMA_VERSION,
  type CodexThreadCatalogHost,
  type CodexThreadCatalogRecord,
  type CodexThreadCatalogResult,
  type MachineDirectoryConnector,
  type MachineDirectoryMachine,
  type MachineDirectoryResult,
  type MachineSignal,
  type MachineSshConnectionResult,
  type SshAvailabilityState,
  type TailscaleReachabilityState
} from '../../src/shared/machine-directory-api';
import type {
  MachineRecord,
  PhysicalMachineRecord
} from '../../src/shared/project-space-api';

export interface MachineDirectoryIdentity {
  architecture: string;
  hostname: string;
  id: string;
  lastSeenAt?: string;
  name: string;
  operatingSystem: string;
}

export interface MachineHostProbeResult {
  ssh: MachineSignal<SshAvailabilityState>;
  tailscale: MachineSignal<TailscaleReachabilityState>;
}

interface MachineDirectoryInventory {
  connectors: MachineRecord[];
  identities: MachineDirectoryIdentity[];
  physicalMachines: PhysicalMachineRecord[];
}

export interface MachineDirectoryServiceOptions {
  inventory(userId: string): Promise<MachineDirectoryInventory>;
  listCodexSessions(
    userId: string,
    connectorId: string,
    request: { includeArchived: boolean; search?: string }
  ): Promise<CodexSessionListResult>;
  now?(): Date;
  probe(hostname: string): Promise<MachineHostProbeResult>;
}

export interface CodexThreadDirectoryFilter {
  includeArchived: boolean;
  machineId?: string;
  machineName?: string;
  search?: string;
  states?: string[];
}

export interface MachineDirectoryActor {
  callerMachineId?: string;
  userId: string;
}

export type MachineDirectoryThreadFilter = CodexThreadDirectoryFilter;

export class MachineDirectoryServiceError extends Error {
  constructor(
    readonly code:
      | 'machine_ambiguous'
      | 'machine_unavailable'
      | 'ssh_unavailable',
    message: string
  ) {
    super(message);
    this.name = 'MachineDirectoryServiceError';
  }
}

export function createMachineDirectoryService(
  options: MachineDirectoryServiceOptions
) {
  const now = options.now ?? (() => new Date());

  async function listMachines(
    actor: { userId: string }
  ): Promise<MachineDirectoryResult> {
    const inventory = await loadInventory(options, actor.userId);
    const checkedAt = now().toISOString();
    const connectorById = new Map(
      inventory.connectors.map((connector) => [connector.id, connector])
    );
    const identityById = new Map(
      inventory.identities.map((identity) => [identity.id, identity])
    );
    const failures: MachineDirectoryResult['failures'] = [];

    const machines = await Promise.all(
      inventory.physicalMachines.map(async (physicalMachine) => {
        const identities = physicalMachine.connectorIds.flatMap((id) => {
          const identity = identityById.get(id);
          return identity ? [identity] : [];
        });
        const hostnames = uniqueSorted(identities.map((identity) => identity.hostname));
        let probe = unknownProbe();
        if (hostnames.length === 1) {
          try {
            probe = await options.probe(hostnames[0]!);
          } catch {
            failures.push({
              machineId: physicalMachine.id,
              message: 'Machine reachability could not be checked.',
              source: 'probe'
            });
          }
        } else {
          failures.push({
            machineId: physicalMachine.id,
            message: hostnames.length === 0
              ? 'No approved machine hostname is available.'
              : 'The connector installations do not identify one physical hostname.',
            source: 'identity'
          });
        }
        return presentMachine(
          physicalMachine,
          identities,
          physicalMachine.connectorIds.flatMap((id) => {
            const connector = connectorById.get(id);
            return connector ? [connector] : [];
          }),
          probe
        );
      })
    );

    machines.sort(machineOrder);
    failures.sort((left, right) =>
      compareText(left.machineId, right.machineId) ||
      compareText(left.source, right.source)
    );
    return {
      checkedAt,
      failures,
      machines,
      schemaVersion: MACHINE_DIRECTORY_SCHEMA_VERSION
    };
  }

  async function resolveSsh(
    actor: { userId: string },
    physicalMachineId: string
  ): Promise<MachineSshConnectionResult> {
    const [directory, inventory] = await Promise.all([
      listMachines(actor),
      loadInventory(options, actor.userId)
    ]);
    const machine = directory.machines.find((candidate) =>
      candidate.id === physicalMachineId
    );
    const physical = inventory.physicalMachines.find((candidate) =>
      candidate.id === physicalMachineId
    );
    if (!machine || !physical) {
      throw new MachineDirectoryServiceError(
        'machine_unavailable',
        'The selected physical machine is unavailable or not authorized.'
      );
    }
    if (
      machine.tailscale.state !== 'reachable' ||
      machine.ssh.state !== 'available'
    ) {
      throw new MachineDirectoryServiceError(
        'ssh_unavailable',
        sshUnavailableMessage(machine)
      );
    }
    const identityById = new Map(
      inventory.identities.map((identity) => [identity.id, identity])
    );
    const hostnames = uniqueSorted(physical.connectorIds.flatMap((id) => {
      const hostname = identityById.get(id)?.hostname;
      return hostname ? [hostname] : [];
    }));
    if (hostnames.length !== 1) {
      throw new MachineDirectoryServiceError(
        'ssh_unavailable',
        'The selected physical machine has no unambiguous approved SSH hostname.'
      );
    }
    return {
      machine: { id: machine.id, name: machine.name },
      schemaVersion: MACHINE_DIRECTORY_SCHEMA_VERSION,
      target: hostnames[0]!
    };
  }

  async function listCodexThreads(
    actor: { userId: string },
    filter: CodexThreadDirectoryFilter
  ): Promise<CodexThreadCatalogResult> {
    const inventory = await loadInventory(options, actor.userId);
    const checkedAt = now().toISOString();
    const physicalMachines = selectPhysicalMachines(
      inventory.physicalMachines,
      filter
    );
    const hosts: CodexThreadCatalogHost[] = [];
    const threads: CodexThreadCatalogRecord[] = [];

    await Promise.all(physicalMachines.flatMap((physicalMachine) =>
      physicalMachine.connectorIds.map(async (connectorId) => {
        try {
          const listed = await options.listCodexSessions(
            actor.userId,
            connectorId,
            {
              includeArchived: filter.includeArchived,
              ...(filter.search ? { search: filter.search } : {})
            }
          );
          const inventoryState = listed.inventoryState === 'stale' ? 'stale' : 'live';
          hosts.push({
            checkedAt: listed.checkedAt,
            connectorId,
            inventoryState,
            machineId: physicalMachine.id,
            machineName: physicalMachine.name,
            ...(listed.machine.statusMessage
              ? { message: listed.machine.statusMessage }
              : {})
          });
          for (const session of listed.sessions) {
            if (!filter.includeArchived && session.archived) continue;
            if (!matchesSearch(session, filter.search)) continue;
            if (filter.states?.length && !filter.states.includes(session.status)) continue;
            threads.push({
              archived: session.archived,
              connectorId,
              ...(session.cwd ? { cwd: session.cwd } : {}),
              id: session.id,
              inventoryState,
              machine: {
                id: physicalMachine.id,
                name: physicalMachine.name
              },
              ...(session.project ? { project: session.project } : {}),
              ...(repositoryContext(session.project)
                ? { repository: session.project }
                : {}),
              state: session.status,
              title: session.title,
              updatedAt: session.lastActivityAt
            });
          }
        } catch {
          hosts.push({
            checkedAt,
            connectorId,
            inventoryState: 'unavailable',
            machineId: physicalMachine.id,
            machineName: physicalMachine.name,
            message: 'This connector could not provide a Codex task inventory.'
          });
        }
      })
    ));

    hosts.sort(hostOrder);
    threads.sort(threadOrder);
    return {
      checkedAt,
      hosts,
      partial: hosts.some((host) => host.inventoryState !== 'live'),
      schemaVersion: MACHINE_DIRECTORY_SCHEMA_VERSION,
      threads
    };
  }

  return { listCodexThreads, listMachines, resolveSsh };
}

async function loadInventory(
  options: MachineDirectoryServiceOptions,
  userId: string
) {
  if (!userId.trim()) {
    throw new MachineDirectoryServiceError(
      'machine_unavailable',
      'Authentication is required.'
    );
  }
  return options.inventory(userId);
}

function presentMachine(
  physical: PhysicalMachineRecord,
  identities: MachineDirectoryIdentity[],
  connectors: MachineRecord[],
  probe: MachineHostProbeResult
): MachineDirectoryMachine {
  const installations = connectors.map(presentConnector).sort((left, right) =>
    compareText(left.id, right.id)
  );
  const connectorStates = installations.map((connector) => connector.state);
  const connectorState = connectorStates.length === 0
    ? 'unknown'
    : connectorStates.every((state) => state === 'ready')
      ? 'ready'
      : connectorStates.every((state) => state === 'unavailable')
        ? 'unavailable'
        : 'degraded';
  const daemonEvidence = connectors.flatMap((connector) =>
    connector.connector.daemon ? [connector.connector.daemon] : []
  );
  const readyDaemon = daemonEvidence.find((daemon) => daemon.state === 'ready');
  const newestDaemon = newestTimestamp(daemonEvidence.map((daemon) => daemon.checkedAt));
  const readyDaemonLastSeen = newestTimestamp(
    daemonEvidence
      .filter((daemon) => daemon.state === 'ready')
      .map((daemon) => daemon.checkedAt)
  );
  const connectorLastSeen = newestTimestamp(
    installations.map((connector) => connector.lastSeenAt)
  );
  const enrollmentLastSeen = newestTimestamp(
    identities.map((identity) => identity.lastSeenAt)
  );
  const appServerState = readyDaemon
    ? 'available'
    : daemonEvidence.length === 0
      ? 'unknown'
      : daemonEvidence.every((daemon) => daemon.state === 'unsupported')
        ? 'unsupported'
        : daemonEvidence.some((daemon) =>
            daemon.state === 'missing' ||
            daemon.state === 'stopped' ||
            daemon.state === 'incompatible' ||
            daemon.state === 'authorization-required' ||
            daemon.state === 'remote-control-disabled' ||
            daemon.state === 'pairing-required'
          )
          ? 'unavailable'
          : 'stale';

  return {
    codexAppServer: {
      ...(newestDaemon ? { checkedAt: newestDaemon } : {}),
      ...(readyDaemonLastSeen ? { lastSeenAt: readyDaemonLastSeen } : {}),
      state: appServerState
    },
    connector: {
      ...(connectorLastSeen ? { lastSeenAt: connectorLastSeen } : {}),
      installations,
      state: connectorState
    },
    enrollment: {
      ...(enrollmentLastSeen ? { lastSeenAt: enrollmentLastSeen } : {}),
      state: identities.length > 0 ? 'enrolled' : 'unknown'
    },
    id: physical.id,
    name: physical.name,
    platform: {
      architectures: uniqueSorted(identities.map((identity) => identity.architecture)),
      operatingSystems: uniqueSorted(
        identities.map((identity) => identity.operatingSystem)
      )
    },
    ssh: probe.ssh,
    tailscale: probe.tailscale
  };
}

function presentConnector(connector: MachineRecord): MachineDirectoryConnector {
  const online = connector.connector.status === 'online' ||
    connector.connector.status === 'local';
  return {
    ...(connector.environment
      ? { environment: connector.environment.label ?? connector.environment.kind }
      : {}),
    id: connector.id,
    ...(connector.connector.lastSeen
      ? { lastSeenAt: connector.connector.lastSeen }
      : {}),
    name: connector.name,
    state: online
      ? 'ready'
      : connector.connector.status === 'offline' ||
          connector.connector.status === 'not-installed'
        ? 'unavailable'
        : 'unknown'
  };
}

function selectPhysicalMachines(
  machines: PhysicalMachineRecord[],
  filter: Pick<CodexThreadDirectoryFilter, 'machineId' | 'machineName'>
) {
  if (filter.machineId && filter.machineName) {
    throw new MachineDirectoryServiceError(
      'machine_ambiguous',
      'Select a machine by name or ID, not both.'
    );
  }
  const selected = machines.filter((machine) =>
    filter.machineId
      ? machine.id === filter.machineId
      : filter.machineName
        ? machine.name === filter.machineName
        : true
  );
  if ((filter.machineId || filter.machineName) && selected.length !== 1) {
    throw new MachineDirectoryServiceError(
      selected.length > 1 ? 'machine_ambiguous' : 'machine_unavailable',
      selected.length > 1
        ? 'More than one physical machine has this name; use --machine-id.'
        : 'The selected physical machine is unavailable or not authorized.'
    );
  }
  return selected.sort(machineOrder);
}

function unknownProbe(): MachineHostProbeResult {
  return {
    ssh: {
      message: 'No trustworthy SSH evidence is available.',
      state: 'unknown'
    },
    tailscale: {
      message: 'No trustworthy Tailscale evidence is available.',
      state: 'unknown'
    }
  };
}

function matchesSearch(
  session: CodexSessionListResult['sessions'][number],
  search: string | undefined
) {
  const value = search?.trim().toLocaleLowerCase();
  if (!value) return true;
  return [session.title, session.cwd, session.project, session.model]
    .some((candidate) => candidate?.toLocaleLowerCase().includes(value));
}

function repositoryContext(project: string | undefined) {
  return project && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(project)
    ? project
    : undefined;
}

function sshUnavailableMessage(machine: MachineDirectoryMachine) {
  if (machine.tailscale.state !== 'reachable') {
    return `Tailscale is ${machine.tailscale.state}; SSH was not opened.`;
  }
  return `SSH is ${machine.ssh.state} for this physical machine.`;
}

function newestTimestamp(values: Array<string | undefined>) {
  return values.filter((value): value is string => Boolean(value)).sort((left, right) =>
    Date.parse(right) - Date.parse(left)
  )[0];
}

function uniqueSorted(values: string[]) {
  return [...new Set(values.filter(Boolean))].sort(compareText);
}

function compareText(left: string, right: string) {
  const folded = left.toLocaleLowerCase().localeCompare(right.toLocaleLowerCase());
  return folded || left.localeCompare(right);
}

function machineOrder(
  left: Pick<MachineDirectoryMachine | PhysicalMachineRecord, 'id' | 'name'>,
  right: Pick<MachineDirectoryMachine | PhysicalMachineRecord, 'id' | 'name'>
) {
  return compareText(left.name, right.name) || compareText(left.id, right.id);
}

function hostOrder(left: CodexThreadCatalogHost, right: CodexThreadCatalogHost) {
  return compareText(left.machineName, right.machineName) ||
    compareText(left.machineId, right.machineId) ||
    compareText(left.connectorId, right.connectorId);
}

function threadOrder(left: CodexThreadCatalogRecord, right: CodexThreadCatalogRecord) {
  return Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
    compareText(left.title, right.title) ||
    compareText(left.machine.id, right.machine.id) ||
    compareText(left.id, right.id);
}
