import { useMemo, useState } from 'react';
import {
  Archive,
  Boxes,
  ChevronRight,
  Cloud,
  Cpu,
  ExternalLink,
  MonitorCog,
  Pencil,
  RefreshCw
} from 'lucide-react';
import { Disclosure } from '@heroui/react';
import { Button, Chip, Text } from '@/app/dotnaos-ui';
import type {
  ConnectorCredentialRecord,
  ConnectorInstallationRecord,
  PhysicalMachineRecord,
  PhysicalMachineSaveRequest
} from '@/shared/project-space-api';
import type {
  ComputeEnvironmentNode,
  ComputeInventorySnapshot,
  ComputePlatformNode,
  ResourceProfile
} from '@/shared/compute-environment-api';
import { groupComputeInventory, hostAssociationLabel } from '@/shared/compute-environment-api';
import { ConnectorChannelChip } from './connector-channel-chip';
import { MachineConnectorActionsMenu } from './machine-connector-actions-menu';
import { MachineConnectionIcon, MachineDeviceIcon, MachineOsMark } from './machine-visuals';
import {
  groupSettingsMachines,
  safeConnectorOrigin,
  type SettingsConnectorInstance,
  type SettingsMachineGroup
} from './settings-machine-group-model';
import { SettingsMachineRuntimeStop } from './settings-machine-runtime-stop';
import { SettingsConnectorMachineEditor } from './settings-connector-machine-editor';
import {
  settingsMachineGroupsPresentation,
  type SettingsMachineGroupsStatus
} from './settings-machine-groups-view-model';

interface SettingsMachineGroupsProps {
  connectors: readonly ConnectorInstallationRecord[];
  credentials: readonly ConnectorCredentialRecord[];
  loadError: string;
  onRefresh(): Promise<unknown>;
  onSaveMachine(request: PhysicalMachineSaveRequest): Promise<void>;
  computeInventory?: ComputeInventorySnapshot;
  physicalMachines: readonly PhysicalMachineRecord[];
  status: SettingsMachineGroupsStatus;
}

function formatBytes(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let amount = value;
  let unit = 0;
  while (amount >= 1_024 && unit < units.length - 1) {
    amount /= 1_024;
    unit += 1;
  }
  return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
}

function resourceSummary(resources: ResourceProfile | undefined) {
  if (!resources) return 'Resources not reported';
  return [
    `${resources.cpu.cores} CPU`,
    formatBytes(resources.memory.limitBytes ?? resources.memory.totalBytes),
    formatBytes(resources.storage.totalBytes),
    resources.gpu?.length ? `${resources.gpu.length} GPU` : undefined
  ].filter(Boolean).join(' · ');
}

const environmentLabels: Record<ComputeEnvironmentNode['environment']['kind'], string> = {
  cloud_sandbox: 'Cloud sandbox',
  devbox: 'Devbox',
  docker: 'Docker',
  github_codespace: 'GitHub Codespace',
  kubernetes_workload: 'Kubernetes workload',
  native_linux: 'Linux',
  native_macos: 'macOS',
  native_windows: 'Windows',
  other: 'Environment',
  virtual_machine: 'Virtual machine',
  wsl: 'WSL'
};

function EnvironmentRow({
  node,
  instancesById,
  onEditConnector,
  onRefresh
}: {
  node: ComputeEnvironmentNode;
  instancesById: ReadonlyMap<string, SettingsConnectorInstance>;
  onEditConnector(instance: SettingsConnectorInstance): void;
  onRefresh(): Promise<unknown>;
}) {
  const instances = node.connectors.flatMap(({ connectorId }) => {
    const instance = instancesById.get(connectorId);
    return instance ? [instance] : [];
  });
  return (
    <div className="border-t border-neutral-900 first:border-t-0">
      <div className="flex min-w-0 items-start gap-3 px-4 py-3">
        <Boxes className="mt-0.5 size-4 shrink-0 text-violet-300" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Text className="truncate text-sm font-medium text-neutral-100">{node.environment.name}</Text>
            <Chip size="sm" variant="secondary">{environmentLabels[node.environment.kind]}</Chip>
            <Chip
              size="sm"
              variant={node.environment.hostAssociation.resolution === 'verified' ? 'primary' : 'secondary'}
            >
              {hostAssociationLabel(node.environment.hostAssociation)}
            </Chip>
            {node.environment.identityResolution === 'conflict' ? (
              <Chip size="sm" variant="secondary">Identity conflict · re-enroll required</Chip>
            ) : null}
          </div>
          <Text className="mt-0.5 block text-xs text-neutral-500">
            {resourceSummary(node.environment.resources)} · {instances.length} connector{instances.length === 1 ? '' : 's'}
          </Text>
        </div>
      </div>
      <div className="border-t border-neutral-900/70 bg-neutral-950/35 pl-5 sm:pl-8">
        {instances.map((instance) => (
          <ConnectorInstanceRow
            key={instance.id}
            instance={instance}
            onEdit={() => onEditConnector(instance)}
            onRefresh={onRefresh}
          />
        ))}
        {node.children.map((child) => (
          <EnvironmentRow
            key={child.environment.id}
            node={child}
            instancesById={instancesById}
            onEditConnector={onEditConnector}
            onRefresh={onRefresh}
          />
        ))}
      </div>
    </div>
  );
}

function PlatformRow({
  node,
  instancesById,
  onEditConnector,
  onRefresh
}: {
  node: ComputePlatformNode;
  instancesById: ReadonlyMap<string, SettingsConnectorInstance>;
  onEditConnector(instance: SettingsConnectorInstance): void;
  onRefresh(): Promise<unknown>;
}) {
  return (
    <Disclosure defaultExpanded className="overflow-hidden border-b border-neutral-800 last:border-b-0">
      <Disclosure.Heading className="flex min-w-0 items-center hover:bg-neutral-900/45">
        <Disclosure.Trigger className="group flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-400/60">
          <Disclosure.Indicator className="size-4 shrink-0 text-neutral-500 transition-transform group-aria-expanded:rotate-90">
            <ChevronRight />
          </Disclosure.Indicator>
          <Cloud className="size-4 shrink-0 text-sky-300" />
          <span className="min-w-0 flex-1">
            <Text className="block truncate text-sm font-semibold text-neutral-100">{node.platform.name}</Text>
            <Text className="block truncate text-xs text-neutral-500">
              {node.hosts.length} host{node.hosts.length === 1 ? '' : 's'} · {node.environments.length + node.hosts.reduce((count, host) => count + host.environments.length, 0)} top-level environment{node.environments.length === 1 ? '' : 's'}
            </Text>
          </span>
        </Disclosure.Trigger>
      </Disclosure.Heading>
      <Disclosure.Content>
        <Disclosure.Body className="bg-neutral-950/20">
          {node.hosts.map((host) => (
            <div key={host.host.id} className="border-t border-neutral-900 first:border-t-0">
              <div className="flex items-start gap-3 bg-neutral-950/45 px-4 py-3 sm:pl-8">
                <Cpu className="mt-0.5 size-4 shrink-0 text-emerald-300" />
                <div className="min-w-0">
                  <Text className="block truncate text-sm font-semibold text-neutral-200">{host.host.name}</Text>
                  <Text className="block text-xs text-neutral-500">{resourceSummary(host.host.resources)}</Text>
                </div>
              </div>
              <div className="pl-3 sm:pl-6">
                {host.environments.map((environment) => (
                  <EnvironmentRow
                    key={environment.environment.id}
                    node={environment}
                    instancesById={instancesById}
                    onEditConnector={onEditConnector}
                    onRefresh={onRefresh}
                  />
                ))}
              </div>
            </div>
          ))}
          {node.environments.length ? (
            <div className="border-t border-neutral-900 first:border-t-0">
              {node.environments.map((environment) => (
                <EnvironmentRow
                  key={environment.environment.id}
                  node={environment}
                  instancesById={instancesById}
                  onEditConnector={onEditConnector}
                  onRefresh={onRefresh}
                />
              ))}
            </div>
          ) : null}
        </Disclosure.Body>
      </Disclosure.Content>
    </Disclosure>
  );
}

function ConnectorInstanceRow({ instance, onEdit, onRefresh }: {
  instance: SettingsConnectorInstance;
  onEdit(): void;
  onRefresh(): Promise<unknown>;
}) {
  const origin = instance.machine.connector.origin;
  const safeOrigin = safeConnectorOrigin(origin);
  return (
    <div className="grid min-w-0 gap-2 border-t border-neutral-900 px-3 py-3 first:border-t-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-4">
      <div className="flex min-w-0 items-start gap-3">
        <MachineConnectionIcon className="mt-1" machine={instance.machine} />
        <MachineOsMark className="mt-1" machine={instance.machine} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <Text className="truncate text-sm font-medium text-neutral-100">
              {instance.platformLabel ?? 'Operating system not reported'}
            </Text>
            <ConnectorChannelChip machine={instance.machine} />
            <Chip size="sm" variant={instance.isOnline ? 'primary' : 'secondary'}>
              {instance.isOnline ? 'Online' : 'Offline'}
            </Chip>
          </div>
          <Text className="mt-0.5 block truncate text-xs text-neutral-500">
            {instance.runtimeLabel}
          </Text>
          <Text className="mt-0.5 block truncate text-xs text-neutral-600">
            {instance.machine.name}
          </Text>
          {safeOrigin ? (
            <a
              className="mt-1 inline-flex max-w-full items-center gap-1 text-xs text-sky-400 hover:text-sky-300"
              href={safeOrigin}
              rel="noreferrer"
              target="_blank"
            >
              <span className="truncate">{safeOrigin}</span>
              <ExternalLink className="size-3 shrink-0" />
            </a>
          ) : origin ? (
            <Text className="mt-1 block truncate text-xs text-neutral-600">{origin}</Text>
          ) : null}
        </div>
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button
          aria-label={`Edit connector ${instance.machine.name}`}
          isIconOnly
          size="sm"
          variant="ghost"
          className="h-8 w-8 min-w-0 px-0"
          onPress={onEdit}
        >
          <Pencil className="size-3.5" />
        </Button>
        <SettingsMachineRuntimeStop machine={instance.machine} onStopped={onRefresh} />
        <MachineConnectorActionsMenu
          machine={instance.machine}
          onOperationSettled={() => void onRefresh()}
        />
      </div>
    </div>
  );
}

function MachineGroupRow({ group, onEditConnector, onRefresh }: {
  group: SettingsMachineGroup;
  onEditConnector(instance: SettingsConnectorInstance): void;
  onRefresh(): Promise<unknown>;
}) {
  return (
    <Disclosure defaultExpanded className="overflow-hidden border-b border-neutral-800 last:border-b-0">
      <Disclosure.Heading className="flex min-w-0 items-center hover:bg-neutral-900/45">
        <Disclosure.Trigger className="group flex min-w-0 flex-1 items-center gap-3 px-3 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-400/60 sm:pl-4">
          <Disclosure.Indicator className="size-4 shrink-0 text-neutral-500 transition-transform group-aria-expanded:rotate-90">
            <ChevronRight />
          </Disclosure.Indicator>
          <MachineDeviceIcon machine={group.instances[0]?.machine ?? group.archivedInstances[0]!.machine} />
          <span className="min-w-0 flex-1">
            <Text className="block truncate text-sm font-semibold text-neutral-100">{group.name}</Text>
            <Text className="block truncate text-xs text-neutral-500">
              {group.onlineConnectorCount} of {group.connectorCount} connectors online
              {group.platformLabels.length ? ` · ${group.platformLabels.join(', ')}` : ''}
            </Text>
          </span>
        </Disclosure.Trigger>
      </Disclosure.Heading>
      <Disclosure.Content>
        <Disclosure.Body className="bg-neutral-950/40 pl-5 sm:pl-8">
          {group.instances.map((instance) => (
            <ConnectorInstanceRow
              key={instance.id}
              instance={instance}
              onEdit={() => onEditConnector(instance)}
              onRefresh={onRefresh}
            />
          ))}
        </Disclosure.Body>
      </Disclosure.Content>
    </Disclosure>
  );
}

export function SettingsMachineGroups({
  computeInventory,
  connectors,
  credentials,
  loadError,
  onRefresh,
  onSaveMachine,
  physicalMachines,
  status
}: SettingsMachineGroupsProps) {
  const [editingConnector, setEditingConnector] = useState<SettingsConnectorInstance>();
  const presentation = settingsMachineGroupsPresentation(status);
  const grouping = useMemo(
    () => groupSettingsMachines({ connectors, credentials, physicalMachines }),
    [connectors, credentials, physicalMachines]
  );
  const archivedCount = grouping.groups.reduce(
    (count, group) => count + group.archivedConnectorCount,
    grouping.archivedUnscopedInstances.length + grouping.unmatchedCredentials.filter(
      (credential) => credential.status === 'revoked' || credential.status === 'expired'
    ).length
  );
  const instancesById = useMemo(() => new Map(
    grouping.groups.flatMap((group) => [...group.instances, ...group.archivedInstances])
      .concat(grouping.unscopedInstances, grouping.archivedUnscopedInstances)
      .map((instance) => [instance.id, instance])
  ), [grouping]);
  const computeHierarchy = useMemo(() => (
    computeInventory && computeInventory.violations.length === 0
      ? groupComputeInventory(computeInventory)
      : undefined
  ), [computeInventory]);

  return (
    <div>
      {presentation.showBlockingLoading ? (
        <div className="rounded-lg border border-neutral-800 px-4 py-8 text-center">
          <Text className="block text-sm text-neutral-500">Loading machine groups…</Text>
        </div>
      ) : presentation.showBlockingError ? (
        <div className="rounded-lg border border-red-500/25 bg-red-500/5 px-4 py-4">
          <Text className="block text-sm text-red-200">{loadError || 'Machine groups could not be loaded.'}</Text>
          <Button className="mt-3" size="sm" variant="outline" onPress={() => void onRefresh()}>Retry</Button>
        </div>
      ) : (
        <>
          {presentation.showRefreshing ? (
            <div className="mb-2 flex items-center gap-1.5 text-xs text-neutral-500" role="status">
              <RefreshCw className="size-3 animate-spin" />
              Updating connector data…
            </div>
          ) : null}
          {loadError ? (
            <div className="mb-2 rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2">
              <Text className="block text-xs text-amber-200">{loadError}</Text>
            </div>
          ) : null}
          <div className="overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950/35">
            {computeHierarchy ? computeHierarchy.platforms.map((platform) => (
              <PlatformRow
                key={platform.platform.id}
                node={platform}
                instancesById={instancesById}
                onEditConnector={setEditingConnector}
                onRefresh={onRefresh}
              />
            )) : grouping.groups.map((group) => (
              <MachineGroupRow
                key={group.id}
                group={group}
                onEditConnector={setEditingConnector}
                onRefresh={onRefresh}
              />
            ))}
            {!computeHierarchy && grouping.unscopedInstances.length > 0 ? (
              <div className="border-t border-neutral-800 first:border-t-0">
                <Text className="block bg-neutral-950/60 px-4 py-2 text-xs font-medium text-neutral-500">
                  Ungrouped connector installations
                </Text>
                {grouping.unscopedInstances.map((instance) => (
                  <ConnectorInstanceRow
                    key={instance.id}
                    instance={instance}
                    onEdit={() => setEditingConnector(instance)}
                    onRefresh={onRefresh}
                  />
                ))}
              </div>
            ) : null}
            {(computeHierarchy ? computeHierarchy.platforms.length === 0 : grouping.groups.length === 0 && grouping.unscopedInstances.length === 0) ? (
              <div className="px-4 py-8 text-center">
                <MonitorCog className="mx-auto size-5 text-neutral-600" />
                <Text className="mt-2 block text-sm text-neutral-500">No connector installations found.</Text>
              </div>
            ) : null}
          </div>
        </>
      )}
      {presentation.showContent && archivedCount > 0 ? (
        <Disclosure className="mt-3 border-t border-neutral-900 pt-2">
          <Disclosure.Heading>
            <Disclosure.Trigger className="group flex items-center gap-2 py-2 text-xs text-neutral-500 hover:text-neutral-300">
              <Disclosure.Indicator className="size-3.5 transition-transform group-aria-expanded:rotate-90"><ChevronRight /></Disclosure.Indicator>
              <Archive className="size-3.5" />
              Archived connector history ({archivedCount})
            </Disclosure.Trigger>
          </Disclosure.Heading>
          <Disclosure.Content>
            <Disclosure.Body className="space-y-1 pb-2 pl-5">
              {grouping.groups.flatMap((group) => group.archivedInstances).concat(grouping.archivedUnscopedInstances).map((instance) => (
                <div key={instance.id} className="flex min-w-0 items-center gap-2 text-xs text-neutral-600">
                  <MachineOsMark machine={instance.machine} />
                  <span className="truncate">
                    {instance.machine.name} · {instance.platformLabel ?? 'Operating system not reported'}
                  </span>
                  <ConnectorChannelChip machine={instance.machine} />
                </div>
              ))}
              {grouping.unmatchedCredentials.filter((credential) => credential.status === 'revoked' || credential.status === 'expired').map((credential) => (
                <Text key={credential.id} className="block truncate text-xs text-neutral-600">
                  {credential.machineId ?? 'Unfinished enrollment'} · {credential.status}
                </Text>
              ))}
            </Disclosure.Body>
          </Disclosure.Content>
        </Disclosure>
      ) : null}

      {editingConnector ? (
        <SettingsConnectorMachineEditor
          key={editingConnector.id}
          connector={editingConnector.machine}
          onClose={() => setEditingConnector(undefined)}
          onSave={onSaveMachine}
          physicalMachines={physicalMachines}
        />
      ) : null}
    </div>
  );
}
