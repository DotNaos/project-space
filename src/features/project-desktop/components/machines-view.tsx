import { useEffect, useRef, useState } from 'react';
import { MonitorCog } from 'lucide-react';

import { Surface, Text } from '@/app/dotnaos-ui';
import { projectSpaceClient } from '@/api/project-space-client';
import type {
  ConnectorCredentialRecord,
  ConnectorOverviewResult,
  PhysicalMachineRecord,
  PhysicalMachineSaveRequest
} from '@/shared/project-space-api';
import { SettingsMachineGroups } from './settings-machine-groups';

export function MachinesView({
  connectorOverview,
  onRefreshConnectorOverview
}: {
  connectorOverview: ConnectorOverviewResult;
  onRefreshConnectorOverview(): Promise<ConnectorOverviewResult>;
}) {
  const [credentials, setCredentials] = useState<ConnectorCredentialRecord[]>([]);
  const [machines, setMachines] = useState<PhysicalMachineRecord[]>([]);
  const [loadError, setLoadError] = useState('');
  const [status, setStatus] = useState<'error' | 'loading' | 'ready' | 'refreshing'>('loading');
  const hasSnapshot = useRef(false);

  async function refresh() {
    setStatus(hasSnapshot.current ? 'refreshing' : 'loading');
    setLoadError('');
    try {
      const [machineResult, credentialResult, connectorResult] = await Promise.all([
        projectSpaceClient.listPhysicalMachines(),
        projectSpaceClient.listConnectorCredentials(),
        onRefreshConnectorOverview()
      ]);
      setMachines(machineResult.machines);
      setCredentials(credentialResult.credentials);
      hasSnapshot.current = true;
      setStatus('ready');
      return connectorResult;
    } catch (error) {
      setStatus(hasSnapshot.current ? 'ready' : 'error');
      setLoadError(error instanceof Error ? error.message : 'Could not load machines.');
      throw error;
    }
  }

  useEffect(() => {
    void refresh().catch(() => undefined);
  }, []);

  async function saveMachine(request: PhysicalMachineSaveRequest) {
    await projectSpaceClient.savePhysicalMachine(request);
    await refresh();
  }

  async function deleteMachine(machineId: string) {
    const result = await projectSpaceClient.deletePhysicalMachine(machineId);
    if (!result.deleted) {
      throw new Error('Only machines without connectors or connection history can be deleted.');
    }
    await refresh();
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-5">
      <div>
        <div className="flex items-center gap-2">
          <MonitorCog className="size-5 text-neutral-400" />
          <Text as="h1" className="text-xl font-semibold text-neutral-50">Machines</Text>
        </div>
        <Text className="mt-1 block max-w-3xl text-sm text-neutral-500">
          Create physical or virtual machines first, then assign every connector installation to exactly one machine.
        </Text>
      </div>

      <Surface variant="tertiary" className="rounded-lg border border-neutral-800 bg-neutral-950/45 p-4">
        <SettingsMachineGroups
          connectors={connectorOverview.machines}
          credentials={credentials}
          loadError={loadError}
          onDeleteMachine={deleteMachine}
          onRefresh={refresh}
          onSaveMachine={saveMachine}
          physicalMachines={machines}
          status={status}
        />
      </Surface>
    </div>
  );
}
