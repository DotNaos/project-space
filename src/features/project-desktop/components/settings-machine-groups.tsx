import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  ChevronRight,
  ExternalLink,
  MonitorCog,
  Pencil,
  Plus,
  RefreshCw,
  Trash2
} from 'lucide-react';
import { AlertDialog, Disclosure } from '@heroui/react';
import { Button, Chip, Text } from '@/app/dotnaos-ui';
import type {
  ConnectorCredentialRecord,
  MachineExecutionScopeRecord,
  MachineExecutionScopeSaveRequest,
  MachineRecord
} from '@/shared/project-space-api';
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
import { SettingsMachineScopeEditor } from './settings-machine-scope-editor';
import {
  settingsMachineGroupsPresentation,
  type SettingsMachineGroupsStatus
} from './settings-machine-groups-view-model';

interface SettingsMachineGroupsProps {
  credentials: readonly ConnectorCredentialRecord[];
  loadError: string;
  machines: readonly MachineRecord[];
  onDeleteScope(scopeId: string): Promise<void>;
  onRefresh(): Promise<unknown>;
  onSaveScope(request: MachineExecutionScopeSaveRequest): Promise<void>;
  scopes: readonly MachineExecutionScopeRecord[];
  status: SettingsMachineGroupsStatus;
}

function ConnectorInstanceRow({ instance, onRefresh }: {
  instance: SettingsConnectorInstance;
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
        <SettingsMachineRuntimeStop machine={instance.machine} onStopped={onRefresh} />
        <MachineConnectorActionsMenu
          machine={instance.machine}
          onOperationSettled={() => void onRefresh()}
        />
      </div>
    </div>
  );
}

function MachineGroupRow({ group, onDelete, onEdit, onRefresh }: {
  group: SettingsMachineGroup;
  onDelete(): void;
  onEdit(): void;
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
        <span className="flex shrink-0 items-center gap-1 pr-3 sm:pr-4">
          <Button aria-label={`Edit ${group.name}`} isIconOnly size="sm" variant="ghost" className="h-8 w-8 min-w-0 px-0" onPress={onEdit}>
            <Pencil className="size-3.5" />
          </Button>
          <Button aria-label={`Ungroup ${group.name}`} isIconOnly size="sm" variant="ghost" className="h-8 w-8 min-w-0 px-0 text-neutral-500 hover:text-red-300" onPress={onDelete}>
            <Trash2 className="size-3.5" />
          </Button>
        </span>
      </Disclosure.Heading>
      <Disclosure.Content>
        <Disclosure.Body className="bg-neutral-950/40 pl-5 sm:pl-8">
          {group.instances.map((instance) => (
            <ConnectorInstanceRow key={instance.id} instance={instance} onRefresh={onRefresh} />
          ))}
        </Disclosure.Body>
      </Disclosure.Content>
    </Disclosure>
  );
}

export function SettingsMachineGroups({
  credentials,
  loadError,
  machines,
  onDeleteScope,
  onRefresh,
  onSaveScope,
  scopes,
  status
}: SettingsMachineGroupsProps) {
  const [editorScopeId, setEditorScopeId] = useState<string | null>();
  const [deletingGroup, setDeletingGroup] = useState<SettingsMachineGroup>();
  const [deleteError, setDeleteError] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  const presentation = settingsMachineGroupsPresentation(status);
  const grouping = useMemo(
    () => groupSettingsMachines({ credentials, machines, scopes }),
    [credentials, machines, scopes]
  );
  const editing = scopes.find((scope) => scope.id === editorScopeId);
  const archivedCount = grouping.groups.reduce(
    (count, group) => count + group.archivedConnectorCount,
    grouping.archivedUnscopedInstances.length + grouping.unmatchedCredentials.filter(
      (credential) => credential.status === 'revoked' || credential.status === 'expired'
    ).length
  );

  async function deleteScope() {
    if (!deletingGroup) return;
    setIsDeleting(true);
    setDeleteError('');
    try {
      await onDeleteScope(deletingGroup.id);
      setDeletingGroup(undefined);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : 'Could not ungroup the machine.');
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <div>
      <div className="mb-3 flex min-w-0 flex-wrap items-center justify-end gap-3">
        <Button size="sm" variant="outline" isDisabled={status !== 'ready'} onPress={() => setEditorScopeId(null)}>
          <Plus className="size-3.5" />
          Group connectors
        </Button>
      </div>

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
            {grouping.groups.map((group) => (
              <MachineGroupRow key={group.id} group={group} onDelete={() => setDeletingGroup(group)} onEdit={() => setEditorScopeId(group.id)} onRefresh={onRefresh} />
            ))}
            {grouping.unscopedInstances.length > 0 ? (
              <div className="border-t border-neutral-800 first:border-t-0">
                <Text className="block bg-neutral-950/60 px-4 py-2 text-xs font-medium text-neutral-500">
                  Ungrouped connector instances
                </Text>
                {grouping.unscopedInstances.map((instance) => (
                  <ConnectorInstanceRow key={instance.id} instance={instance} onRefresh={onRefresh} />
                ))}
              </div>
            ) : null}
            {grouping.groups.length === 0 && grouping.unscopedInstances.length === 0 ? (
              <div className="px-4 py-8 text-center">
                <MonitorCog className="mx-auto size-5 text-neutral-600" />
                <Text className="mt-2 block text-sm text-neutral-500">No connector instances found.</Text>
              </div>
            ) : null}
          </div>
        </>
      )}
      {deleteError ? <Text className="mt-2 block text-xs text-red-300">{deleteError}</Text> : null}

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

      {editorScopeId !== undefined ? (
        <SettingsMachineScopeEditor key={editing?.id ?? 'new'} editing={editing} machines={machines} onClose={() => setEditorScopeId(undefined)} onSave={onSaveScope} scopes={scopes} />
      ) : null}

      <AlertDialog isOpen={Boolean(deletingGroup)} onOpenChange={(open) => { if (!open && !isDeleting) setDeletingGroup(undefined); }}>
        <AlertDialog.Backdrop isDismissable={false} variant="blur" className="z-[90] bg-black/75">
          <AlertDialog.Container placement="auto" size="md" className="px-3 py-3 sm:px-5 sm:py-6">
            <AlertDialog.Dialog className="border border-neutral-800 bg-neutral-950 text-neutral-100">
              <AlertDialog.Header>
                <AlertDialog.Icon status="warning"><AlertTriangle className="size-5" /></AlertDialog.Icon>
                <AlertDialog.Heading>Ungroup {deletingGroup?.name}?</AlertDialog.Heading>
              </AlertDialog.Header>
              <AlertDialog.Body>
                <Text className="block text-sm leading-6 text-neutral-300">
                  The group will be removed. Its connector instances stay registered and will appear as ungrouped.
                </Text>
              </AlertDialog.Body>
              <AlertDialog.Footer className="gap-2">
                <Button variant="ghost" isDisabled={isDeleting} onPress={() => setDeletingGroup(undefined)}>Cancel</Button>
                <Button variant="danger" isDisabled={isDeleting} onPress={() => void deleteScope()}>
                  {isDeleting ? 'Ungrouping…' : 'Ungroup'}
                </Button>
              </AlertDialog.Footer>
            </AlertDialog.Dialog>
          </AlertDialog.Container>
        </AlertDialog.Backdrop>
      </AlertDialog>
    </div>
  );
}
