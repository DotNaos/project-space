import type { ConnectorOverviewResult, ProjectSpaceRecord } from '@/shared/project-space-api';
import { Button, Text } from '@/app/dotnaos-ui';
import {
  isMachineConnected,
  MachineBatteryMeter,
  MachineConnectionIcon,
  MachineDeviceIcon,
  MachineOsMark
} from './machine-visuals';
import {
  formatRelativeTime,
  getProjectTimestamp,
  isVisibleProject,
  machineSubtitle
} from './project-main-model';

export function ProjectRootOverview({
  connector,
  onOpenMachines,
  onOpenMachine,
  onOpenProjects,
  onSelectProject,
  projects
}: {
  connector: ConnectorOverviewResult;
  onOpenMachines(): void;
  onOpenMachine(machineId: string): void;
  onOpenProjects(): void;
  onSelectProject(projectId: string): void;
  projects: ProjectSpaceRecord[];
}) {
  const connectedMachines = connector.machines.filter(isMachineConnected);
  const recentProjects = projects
    .filter(isVisibleProject)
    .sort((left, right) => {
      const timestampDelta = getProjectTimestamp(right) - getProjectTimestamp(left);

      return timestampDelta || left.name.localeCompare(right.name);
    })
    .slice(0, 8);
  const hasProjectTimestamps = recentProjects.some((project) => getProjectTimestamp(project) > 0);

  return (
    <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-8 pt-4">
      <section>
        <div className="mb-2 flex items-center justify-between gap-3">
          <Text className="text-sm font-semibold text-neutral-100">Running machines</Text>
          <Button size="sm" variant="ghost" onPress={onOpenMachines}>
            View all
          </Button>
        </div>

        {connectedMachines.length > 0 ? (
          <div className="divide-y divide-neutral-900/80">
            {connectedMachines.map((machine) => (
              <button
                key={machine.id}
                type="button"
                onClick={() => onOpenMachine(machine.id)}
                className="flex w-full min-w-0 items-center gap-3 rounded-lg px-3 py-3 text-left transition hover:bg-neutral-900/50"
              >
                <MachineConnectionIcon machine={machine} />
                <MachineDeviceIcon machine={machine} />
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <Text className="block truncate text-sm font-medium text-neutral-100">
                      {machine.name}
                    </Text>
                    <MachineOsMark machine={machine} />
                  </span>
                  <Text className="block truncate text-xs text-neutral-500">
                    {machineSubtitle(machine) || machine.connector.status}
                  </Text>
                </span>
                <MachineBatteryMeter compact machine={machine} />
              </button>
            ))}
          </div>
        ) : (
          <div className="rounded-lg bg-neutral-950/45 px-4 py-5">
            <Text className="text-sm text-neutral-500">No machines are currently connected.</Text>
          </div>
        )}
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between gap-3">
          <Text className="text-sm font-semibold text-neutral-100">
            {hasProjectTimestamps ? 'Recent projects' : 'Projects'}
          </Text>
          <Button size="sm" variant="ghost" onPress={onOpenProjects}>
            View all
          </Button>
        </div>

        {recentProjects.length > 0 ? (
          <div className="divide-y divide-neutral-900/80">
            {recentProjects.map((entry) => {
              const timestamp = getProjectTimestamp(entry);
              const label = entry.github?.name ?? entry.name;
              const sublabel = entry.github?.owner ?? (entry.kind === 'github' ? 'GitHub' : 'Local');
              const relative = formatRelativeTime(timestamp);

              return (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => onSelectProject(entry.id)}
                  className="flex w-full min-w-0 items-center justify-between gap-3 rounded-lg px-3 py-3 text-left transition hover:bg-neutral-900/50"
                >
                  <span className="min-w-0">
                    <Text className="block truncate text-sm font-medium text-neutral-100">
                      {label}
                    </Text>
                    <Text className="block truncate text-xs text-neutral-500">{sublabel}</Text>
                  </span>
                  {relative ? (
                    <Text className="shrink-0 text-xs text-neutral-500">{relative}</Text>
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="rounded-lg bg-neutral-950/45 px-4 py-5">
            <Text className="text-sm text-neutral-500">No projects discovered yet.</Text>
          </div>
        )}
      </section>
    </div>
  );
}
