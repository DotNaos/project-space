import type { ConnectorOverviewResult, ProjectSpaceRecord } from '@/shared/project-space-api';
import { useEffect, useMemo, useState, type KeyboardEvent, type KeyboardEventHandler } from 'react';
import {
  Button,
  SearchField,
  SearchFieldClearButton,
  SearchFieldGroup,
  SearchFieldInput,
  SearchFieldSearchIcon,
  Text
} from '@/app/dotnaos-ui';
import { matchesFuzzyQuery } from '@/lib/fuzzy-search';
import { cn } from '@/lib/utils';
import { isMachineConnected } from './machine-visuals';
import { MachineListItem } from './machine-list-item';
import { MachineConnectorActionsMenu } from './machine-connector-actions-menu';
import { runtimeVersionLabel } from './machine-connector-runtime-model';
import { getProjectMachineId, isVisibleProject, machineSubtitle } from './project-main-model';
import { connectorLocationPresentation } from './machine-connector-topology-model';

function HomeSearch({
  label,
  onChange,
  onKeyDown,
  placeholder,
  value
}: {
  label: string;
  onChange(value: string): void;
  onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
  placeholder: string;
  value: string;
}) {
  return (
    <SearchField aria-label={label} value={value} onChange={onChange}>
      <SearchFieldGroup
        className="rounded-lg bg-neutral-900/80"
        onKeyDown={(event) => onKeyDown?.(event as unknown as Parameters<NonNullable<typeof onKeyDown>>[0])}
      >
        <SearchFieldSearchIcon />
        <SearchFieldInput className="text-sm" placeholder={placeholder} spellCheck={false} />
        <SearchFieldClearButton />
      </SearchFieldGroup>
    </SearchField>
  );
}

export function ProjectRootOverview({
  connector,
  onOpenMachines,
  onOpenMachine,
  onOpenProjects,
  onSelectProject,
  projects,
  recentProjectIds
}: {
  connector: ConnectorOverviewResult;
  onOpenMachines(): void;
  onOpenMachine(machineId: string): void;
  onOpenProjects(): void;
  onSelectProject(projectId: string): void;
  projects: ProjectSpaceRecord[];
  recentProjectIds: string[];
}) {
  const [machineQuery, setMachineQuery] = useState('');
  const [projectQuery, setProjectQuery] = useState('');
  const [activeMachineIndex, setActiveMachineIndex] = useState(0);
  const [activeProjectIndex, setActiveProjectIndex] = useState(0);
  const connectedMachines = connector.machines.filter(isMachineConnected);
  const localMachineId =
    connector.machines.find((machine) => machine.connector.status === 'local')?.id ??
    connectedMachines[0]?.id ??
    'local';
  const machinesById = new Map(connector.machines.map((machine) => [machine.id, machine]));
  const localProjectMachine = (project: ProjectSpaceRecord) => {
    const machineId = getProjectMachineId(project, localMachineId);
    const machine = machinesById.get(machineId);

    return {
      href: machineId === 'local' ? '/machines' : `/machines/${encodeURIComponent(machineId)}`,
      label: machine?.name ?? (machineId === 'local' ? 'this machine' : machineId)
    };
  };
  const localProjectLocation = (project: ProjectSpaceRecord) => {
    const machine = localProjectMachine(project);

    return `on ${machine.label}`;
  };
  const displayedMachines = connectedMachines.filter((machine) =>
    matchesFuzzyQuery(
      [
        machine.name,
        machine.id,
        machine.kind,
        machine.profile,
        machine.primaryUser,
        machine.network.localName,
        machine.network.sshUser,
        machine.network.tailscaleIp,
        machine.connector.status
      ],
      machineQuery
    )
  );
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  const openedRecentProjects = recentProjectIds
    .map((projectId) => projectsById.get(projectId))
    .filter((project): project is ProjectSpaceRecord => Boolean(project && isVisibleProject(project)));
  const fallbackProjects = projects
    .filter(isVisibleProject)
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, 8);
  const recentProjects =
    openedRecentProjects.length > 0 ? openedRecentProjects.slice(0, 8) : fallbackProjects;
  const hasOpenedRecentProjects = openedRecentProjects.length > 0;
  const orderedSearchProjects = useMemo(() => {
    const seenProjectIds = new Set<string>();
    const orderedProjects: ProjectSpaceRecord[] = [];

    for (const project of openedRecentProjects) {
      seenProjectIds.add(project.id);
      orderedProjects.push(project);
    }

    for (const project of projects
      .filter(isVisibleProject)
      .sort((left, right) => (left.github?.name ?? left.name).localeCompare(right.github?.name ?? right.name))) {
      if (seenProjectIds.has(project.id)) {
        continue;
      }

      orderedProjects.push(project);
    }

    return orderedProjects;
  }, [openedRecentProjects, projects]);
  const displayedProjects = projectQuery.trim()
    ? orderedSearchProjects
        .filter((project) =>
          matchesFuzzyQuery(
            [
              project.github?.fullName,
              project.github?.name,
              project.github?.owner,
              project.name,
              project.kind,
              project.github ? undefined : localProjectLocation(project)
            ],
            projectQuery
          )
        )
        .slice(0, 16)
    : recentProjects;

  useEffect(() => {
    setActiveMachineIndex(0);
  }, [machineQuery]);

  useEffect(() => {
    if (activeMachineIndex >= displayedMachines.length) {
      setActiveMachineIndex(Math.max(0, displayedMachines.length - 1));
    }
  }, [activeMachineIndex, displayedMachines.length]);

  useEffect(() => {
    setActiveProjectIndex(0);
  }, [projectQuery]);

  useEffect(() => {
    if (activeProjectIndex >= displayedProjects.length) {
      setActiveProjectIndex(Math.max(0, displayedProjects.length - 1));
    }
  }, [activeProjectIndex, displayedProjects.length]);

  function handleMachineSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (displayedMachines.length === 0) {
        return;
      }
      setActiveMachineIndex((index) => Math.min(index + 1, displayedMachines.length - 1));
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (displayedMachines.length === 0) {
        return;
      }
      setActiveMachineIndex((index) => Math.max(index - 1, 0));
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      if (displayedMachines.length === 0) {
        return;
      }
      const machine = displayedMachines[activeMachineIndex] ?? displayedMachines[0];
      if (machine) {
        onOpenMachine(machine.id);
      }
    }
  }

  function handleProjectSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (displayedProjects.length === 0) {
        return;
      }
      setActiveProjectIndex((index) => Math.min(index + 1, displayedProjects.length - 1));
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (displayedProjects.length === 0) {
        return;
      }
      setActiveProjectIndex((index) => Math.max(index - 1, 0));
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      if (displayedProjects.length === 0) {
        return;
      }
      const project = displayedProjects[activeProjectIndex] ?? displayedProjects[0];
      if (project) {
        onSelectProject(project.id);
      }
    }
  }

  function handleProjectRowKeyDown(event: KeyboardEvent<HTMLDivElement>, projectId: string) {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return;
    }

    event.preventDefault();
    onSelectProject(projectId);
  }

  return (
    <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-8 pt-4">
      <section>
        <div className="mb-3 flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <Text className="text-sm font-semibold text-neutral-100">Running machines</Text>
            <Button size="sm" variant="ghost" onPress={onOpenMachines}>
              View all
            </Button>
          </div>
          <HomeSearch
            label="Search machines"
            placeholder="Search machines"
            value={machineQuery}
            onChange={setMachineQuery}
            onKeyDown={handleMachineSearchKeyDown}
          />
        </div>

        {displayedMachines.length > 0 ? (
          <div className="divide-y divide-neutral-900/80">
            {displayedMachines.map((machine) => (
              <div key={machine.id} className="flex min-w-0 items-center">
                <MachineListItem
                  compact
                  machine={machine}
                  name={connectorLocationPresentation({
                    connector: machine,
                    physicalMachines: connector.physicalMachines ?? []
                  }).machineName}
                  subtitle={`${connectorLocationPresentation({
                    connector: machine,
                    physicalMachines: connector.physicalMachines ?? []
                  }).connectorLabel} · ${machineSubtitle(machine) || machine.connector.status}`}
                  onPress={() => onOpenMachine(machine.id)}
                  className={cn(
                    'min-w-0 flex-1',
                  displayedMachines[activeMachineIndex]?.id === machine.id
                    ? 'bg-neutral-900/80'
                    : 'hover:bg-neutral-900/50'
                  )}
                />
                <div className="flex shrink-0 items-center gap-1 pr-1.5">
                  {machine.connector.runtime ? (
                    <Text className="hidden text-xs text-neutral-500 sm:inline">
                      {runtimeVersionLabel(machine)}
                    </Text>
                  ) : null}
                  <MachineConnectorActionsMenu machine={machine} />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-lg bg-neutral-950/45 px-4 py-5">
            <Text className="text-sm text-neutral-500">
              {connectedMachines.length === 0 ? 'No machines are currently connected.' : 'No machines found.'}
            </Text>
          </div>
        )}
      </section>

      <section>
        <div className="mb-3 flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <Text className="text-sm font-semibold text-neutral-100">
              {projectQuery.trim()
                ? 'Projects'
                : hasOpenedRecentProjects
                  ? 'Recently opened'
                  : 'Projects'}
            </Text>
            <Button size="sm" variant="ghost" onPress={onOpenProjects}>
              View all
            </Button>
          </div>
          <HomeSearch
            label="Search projects"
            placeholder="Search all projects"
            value={projectQuery}
            onChange={setProjectQuery}
            onKeyDown={handleProjectSearchKeyDown}
          />
        </div>

        {displayedProjects.length > 0 ? (
          <div className="divide-y divide-neutral-900/80">
            {displayedProjects.map((entry) => {
              const label = entry.github?.name ?? entry.name;
              const machineLocation = entry.github ? undefined : localProjectMachine(entry);
              const sublabel = entry.github?.owner;

              return (
                <div
                  key={entry.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelectProject(entry.id)}
                  onKeyDown={(event) => handleProjectRowKeyDown(event, entry.id)}
                  className={[
                    'flex w-full min-w-0 cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-3 transition focus-visible:outline focus-visible:outline-1 focus-visible:outline-neutral-500',
                    displayedProjects[activeProjectIndex]?.id === entry.id
                      ? 'bg-neutral-900/80'
                      : 'hover:bg-neutral-900/50'
                  ].join(' ')}
                >
                  <span className="min-w-0 flex-1">
                    <Text className="block truncate text-sm font-medium text-neutral-100">{label}</Text>
                    {machineLocation ? (
                      <Text className="block truncate text-xs text-neutral-500">
                        on{' '}
                        <a
                          href={machineLocation.href}
                          onClick={(event) => event.stopPropagation()}
                          onKeyDown={(event) => event.stopPropagation()}
                          className="font-medium text-neutral-300 underline-offset-4 transition hover:text-neutral-50 hover:underline"
                        >
                          {machineLocation.label}
                        </a>
                      </Text>
                    ) : (
                      <Text className="block truncate text-xs text-neutral-500">{sublabel}</Text>
                    )}
                  </span>
                </div>
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
