import type { ConnectorOverviewResult } from '@/shared/project-space-api';

export function ProjectWorkspaceMachineSelect({
  connectorOverview,
  onSelectMachine,
  selectedMachineId
}: {
  connectorOverview: ConnectorOverviewResult;
  onSelectMachine?(machineId: string): void;
  selectedMachineId?: string;
}) {
  if (!onSelectMachine || connectorOverview.machines.length <= 1) return null;

  return (
    <select
      aria-label="Development machine"
      value={selectedMachineId ?? ''}
      onChange={(event) => onSelectMachine(event.currentTarget.value)}
      className="h-8 min-w-0 max-w-52 rounded-lg border border-neutral-800 bg-neutral-900 px-2 text-xs text-neutral-300 outline-none focus-visible:border-sky-400"
    >
      {connectorOverview.machines.map((machine) => (
        <option key={machine.id} value={machine.id}>
          {machine.name} · {machine.connector.status}
        </option>
      ))}
    </select>
  );
}
