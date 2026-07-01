import { useMemo, useState, type WheelEvent } from 'react';
import {
  Button,
  ScrollShadow,
  SearchField,
  SearchFieldClearButton,
  SearchFieldGroup,
  SearchFieldInput,
  SearchFieldSearchIcon,
  Surface,
  Text
} from '@/app/dotnaos-ui';
import { ChevronRight, FolderKanban, House, Server } from 'lucide-react';
import type {
  ConnectorOverviewResult,
  ExplorerTarget,
  MachineRecord,
  ProjectGroupRecord,
  ProjectNavigationItem,
  ProjectSpaceRecord,
  ProjectWorktreeRecord
} from '@/shared/project-space-api';
import type { ProjectMainView } from '../hooks/use-project-desktop';
import type { SidebarView } from './sidebar-content';
import {
  isMachineConnected,
  MachineBatteryMeter,
  MachineConnectionIcon,
  MachineDeviceIcon,
  MachineOsMark
} from './machine-visuals';
import { SidebarContent } from './sidebar-content';
import { SidebarProjectSelect } from './sidebar-project-select';
import { SpacesDock } from './spaces-dock';

function isVisibleProject(project: ProjectSpaceRecord) {
  const folder = project.rootPath.split('/').filter(Boolean).pop() ?? '';

  return !folder.startsWith('.') && !folder.endsWith('.worktrees');
}

function matchesSearch(value: string, query: string) {
  return value.toLowerCase().includes(query.trim().toLowerCase());
}

interface SidebarBreadcrumbItem {
  label: string;
  onPress?: () => void;
}

function SidebarBreadcrumbs({ items }: { items: SidebarBreadcrumbItem[] }) {
  return (
    <nav
      aria-label="Sidebar breadcrumb"
      className="flex min-w-0 items-center gap-1 text-xs text-neutral-500"
    >
      {items.map((item, index) => {
        const isCurrent = index === items.length - 1;
        const content = (
          <span className="block max-w-[13rem] truncate" title={item.label}>
            {item.label}
          </span>
        );

        return (
          <span key={`${item.label}-${index}`} className="flex min-w-0 items-center gap-1">
            {index > 0 ? (
              <ChevronRight className="size-3 shrink-0 text-neutral-700" strokeWidth={1.8} />
            ) : null}
            {item.onPress && !isCurrent ? (
              <button
                type="button"
                onClick={item.onPress}
                className="min-w-0 rounded-md px-1 py-0.5 text-left transition hover:bg-neutral-800/70 hover:text-neutral-200"
              >
                {content}
              </button>
            ) : (
              <Text
                className={
                  isCurrent ? 'min-w-0 px-1 py-0.5 text-neutral-300' : 'min-w-0 px-1 py-0.5'
                }
              >
                {content}
              </Text>
            )}
          </span>
        );
      })}
    </nav>
  );
}

function SidebarSearch({
  label,
  onChange,
  placeholder,
  value
}: {
  label: string;
  onChange(value: string): void;
  placeholder: string;
  value: string;
}) {
  return (
    <SearchField aria-label={label} value={value} onChange={onChange} className="mb-3">
      <SearchFieldGroup className="rounded-lg bg-neutral-900/90">
        <SearchFieldSearchIcon />
        <SearchFieldInput
          className="text-sm"
          placeholder={placeholder}
          spellCheck={false}
        />
        <SearchFieldClearButton />
      </SearchFieldGroup>
    </SearchField>
  );
}

function formatMachineSubtitle(machine: MachineRecord) {
  return [machine.kind, machine.profile, machine.network.localName].filter(Boolean).join(' / ');
}

function SidebarMachineRow({
  machine,
  onSelectMachine
}: {
  machine: MachineRecord;
  onSelectMachine(machineId: string): void;
}) {
  return (
    <button
      key={machine.id}
      type="button"
      onClick={() => onSelectMachine(machine.id)}
      className="flex min-w-0 items-center gap-3 rounded-lg px-3 py-2 text-left transition hover:bg-neutral-800/70"
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
          {formatMachineSubtitle(machine) || machine.connector.status}
        </Text>
      </span>
      <MachineBatteryMeter compact machine={machine} />
    </button>
  );
}

function SidebarMachineSection({
  machines,
  onSelectMachine,
  title
}: {
  machines: MachineRecord[];
  onSelectMachine(machineId: string): void;
  title: string;
}) {
  if (machines.length === 0) {
    return null;
  }

  return (
    <div className="mb-3 last:mb-0">
      <Text className="mb-1 block px-3 text-xs font-medium text-neutral-500">{title}</Text>
      <div className="flex flex-col gap-1">
        {machines.map((machine) => (
          <SidebarMachineRow
            key={machine.id}
            machine={machine}
            onSelectMachine={onSelectMachine}
          />
        ))}
      </div>
    </div>
  );
}

function SidebarMachinesPicker({
  connector,
  onSelectMachine
}: {
  connector: ConnectorOverviewResult;
  onSelectMachine(machineId: string): void;
}) {
  const [query, setQuery] = useState('');

  const machines = useMemo(() => {
    return connector.machines.filter((machine) => {
      if (!query.trim()) {
        return true;
      }

      return matchesSearch(
        [
          machine.name,
          machine.kind,
          machine.profile,
          machine.primaryUser,
          machine.network.localName,
          machine.network.sshUser,
          machine.network.tailscaleIp,
          machine.connector.serviceName,
          machine.connector.status
        ]
          .filter(Boolean)
          .join(' '),
        query
      );
    });
  }, [connector.machines, query]);
  const connectedMachines = machines.filter(isMachineConnected);
  const disconnectedMachines = machines.filter((machine) => !isMachineConnected(machine));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-3 py-2 pb-0">
        <SidebarSearch
          label="Search machines"
          placeholder="Search machines"
          value={query}
          onChange={setQuery}
        />
      </div>

      <ScrollShadow className="min-h-0 flex-1 px-3 pb-2" hideScrollBar>
        <SidebarMachineSection
          title="Connected"
          machines={connectedMachines}
          onSelectMachine={onSelectMachine}
        />
        <SidebarMachineSection
          title="Disconnected"
          machines={disconnectedMachines}
          onSelectMachine={onSelectMachine}
        />

        {machines.length === 0 ? (
          <Text className="px-3 py-2 text-sm text-neutral-500">No machines found.</Text>
        ) : null}
      </ScrollShadow>
    </div>
  );
}

function getProjectOwner(
  project: ProjectSpaceRecord,
  groupsById: Record<string, ProjectGroupRecord>
) {
  if (project.github) {
    return project.github.owner;
  }

  if (project.groupId && groupsById[project.groupId]) {
    return groupsById[project.groupId].name;
  }

  const atNameMatch = project.name.match(/^@([^/]+)\//);
  if (atNameMatch) {
    return `@${atNameMatch[1]}`;
  }

  return 'Local';
}

function getProjectLabel(project: ProjectSpaceRecord, owner: string) {
  if (project.github) {
    return project.github.name;
  }

  if (owner.startsWith('@') && project.name.startsWith(`${owner}/`)) {
    return project.name.slice(owner.length + 1);
  }

  return project.name;
}

function groupProjectsByOwner(
  groupsById: Record<string, ProjectGroupRecord>,
  projects: ProjectSpaceRecord[],
  query: string
) {
  const groups = new Map<string, ProjectSpaceRecord[]>();

  for (const project of projects.filter(isVisibleProject)) {
    const owner = getProjectOwner(project, groupsById);
    const label = getProjectLabel(project, owner);

    if (
      query.trim() &&
      !matchesSearch(`${owner} ${label} ${project.name} ${project.rootPath}`, query)
    ) {
      continue;
    }

    groups.set(owner, [...(groups.get(owner) ?? []), project]);
  }

  return Array.from(groups.entries())
    .map(([owner, entries]) => ({
      entries: [...entries].sort((left, right) =>
        getProjectLabel(left, owner).localeCompare(getProjectLabel(right, owner))
      ),
      owner
    }))
    .sort((left, right) => left.owner.localeCompare(right.owner));
}

function SidebarProjectPicker({
  groups,
  onSelectProject,
  projects
}: {
  groups: ProjectGroupRecord[];
  onSelectProject(projectId: string): void;
  projects: ProjectSpaceRecord[];
}) {
  const [query, setQuery] = useState('');
  const groupsById = useMemo(
    () =>
      groups.reduce<Record<string, ProjectGroupRecord>>((index, group) => {
        index[group.id] = group;
        return index;
      }, {}),
    [groups]
  );
  const projectGroups = useMemo(
    () => groupProjectsByOwner(groupsById, projects, query),
    [groupsById, projects, query]
  );

  if (projects.filter(isVisibleProject).length === 0) {
    return (
      <div className="px-3 py-2">
        <Text className="text-sm text-neutral-500">No projects yet.</Text>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-3 py-2 pb-0">
        <SidebarSearch
          label="Search projects"
          placeholder="Search projects"
          value={query}
          onChange={setQuery}
        />
      </div>

      <ScrollShadow className="min-h-0 flex-1 px-3 pb-2" hideScrollBar>
        <div className="flex flex-col gap-1">
          {projectGroups.map((group) => (
            <div key={group.owner} className="mb-2 last:mb-0">
              <Text className="mb-1 block px-3 text-xs font-medium text-neutral-500">
                {group.owner}
              </Text>
              {group.entries.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => onSelectProject(entry.id)}
                  className="flex min-w-0 items-center rounded-lg px-3 py-2 text-left text-sm font-medium text-neutral-200 transition hover:bg-neutral-800/70 hover:text-neutral-50"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {getProjectLabel(entry, group.owner)}
                  </span>
                </button>
              ))}
            </div>
          ))}

          {projectGroups.length === 0 ? (
            <Text className="px-3 py-2 text-sm text-neutral-500">No projects found.</Text>
          ) : null}
        </div>
      </ScrollShadow>
    </div>
  );
}

interface ProjectSidebarPaneProps {
  activeNavigationItemId: string;
  connectorOverview: ConnectorOverviewResult;
  currentPanelRef: React.RefObject<HTMLDivElement | null>;
  groups: ProjectGroupRecord[];
  groupedProjects: ProjectSpaceRecord[];
  groupedProjectsLabel?: string;
  isOpen: boolean;
  navigationItems: ProjectNavigationItem[];
  onCreateProject(): void;
  onOpenHome(): void;
  onOpenRoot(): void;
  onOpenMachines(): void;
  onOpenProjects(): void;
  onOpenNewWorktree(): void;
  onResizeStart(event: React.MouseEvent<HTMLButtonElement>): void;
  onSelectMachine(machineId: string): void;
  onSelectProject(projectId: string, groupId?: string): void;
  onSelectNavigationItem(itemId: string): void;
  onSelectWorkspace(): void;
  onSelectWorktree(worktreeId: string): void;
  onSidebarWheel(event: WheelEvent<HTMLElement>): void;
  onSidebarViewChange(nextView: SidebarView): void;
  previewPanelRef: React.RefObject<HTMLDivElement | null>;
  previewProject?: ProjectSpaceRecord;
  previewWorktrees: ProjectWorktreeRecord[];
  isHomeSelected: boolean;
  isMachinesSelected: boolean;
  isProjectsSelected: boolean;
  selectedMachine?: MachineRecord;
  project?: ProjectSpaceRecord;
  projects: ProjectSpaceRecord[];
  rootItems: ProjectNavigationItem[];
  selectedExplorerTarget: ExplorerTarget;
  selectedMachineId: string;
  selectedProjectId: string;
  sidebarMode: ProjectMainView;
  sidebarView: SidebarView;
  titlebarSafeInset: number;
  worktrees: ProjectWorktreeRecord[];
}

export function ProjectSidebarPane({
  activeNavigationItemId,
  connectorOverview,
  currentPanelRef,
  groups,
  groupedProjects,
  groupedProjectsLabel,
  isOpen,
  navigationItems,
  onCreateProject,
  onOpenHome,
  onOpenRoot,
  onOpenMachines,
  onOpenProjects,
  onOpenNewWorktree,
  onResizeStart,
  onSelectMachine,
  onSelectProject,
  onSelectNavigationItem,
  onSelectWorkspace,
  onSelectWorktree,
  onSidebarWheel,
  onSidebarViewChange,
  previewPanelRef,
  previewProject,
  previewWorktrees,
  isHomeSelected,
  isMachinesSelected,
  isProjectsSelected,
  selectedMachine,
  project,
  projects,
  rootItems,
  selectedExplorerTarget,
  selectedMachineId,
  selectedProjectId,
  sidebarMode,
  sidebarView,
  titlebarSafeInset,
  worktrees
}: ProjectSidebarPaneProps) {
  const breadcrumbItems: SidebarBreadcrumbItem[] = [
    {
      label: 'Home',
      onPress: sidebarMode === 'root' ? undefined : onOpenRoot
    }
  ];

  if (sidebarMode === 'machines') {
    breadcrumbItems.push({ label: 'Machines' });
  }

  if (sidebarMode === 'machine') {
    breadcrumbItems.push(
      {
        label: 'Machines',
        onPress: onOpenMachines
      },
      { label: selectedMachine?.name ?? (selectedMachineId || 'Machine') }
    );
  }

  if (sidebarMode === 'projects') {
    breadcrumbItems.push({ label: 'Projects' });
  }

  if (sidebarMode === 'project' && project) {
    breadcrumbItems.push(
      {
        label: 'Projects',
        onPress: onOpenProjects
      },
      { label: project.name }
    );
  }

  if (!isOpen) {
    return (
      <Surface
        variant="secondary"
        className="relative z-40 flex min-h-0 min-w-0 flex-col items-center overflow-hidden rounded-none border-r border-neutral-800/60 bg-app-sidebar px-2 pt-16"
      >
        <div className="app-no-drag flex flex-col items-center gap-2">
          <Button
            aria-label="Home"
            data-testid="sidebar-home"
            isIconOnly
            title="Home"
            variant={isHomeSelected ? 'secondary' : 'ghost'}
            onPress={onOpenHome}
            className="h-10 w-10 min-w-0 rounded-xl px-0"
          >
            <House className="size-4" />
          </Button>

          <Button
            aria-label="Machines"
            data-testid="sidebar-machines"
            isIconOnly
            title="Machines"
            variant={sidebarMode === 'machines' || sidebarMode === 'machine' ? 'secondary' : 'ghost'}
            onPress={onOpenMachines}
            className="h-10 w-10 min-w-0 rounded-xl px-0"
          >
            <Server className="size-4" />
          </Button>

          <Button
            aria-label="Projects"
            data-testid="sidebar-projects"
            isIconOnly
            title="Projects"
            variant={sidebarMode === 'projects' || sidebarMode === 'project' ? 'secondary' : 'ghost'}
            onPress={onOpenProjects}
            className="h-10 w-10 min-w-0 rounded-xl px-0"
          >
            <FolderKanban className="size-4" />
          </Button>
        </div>
      </Surface>
    );
  }

  return (
    <Surface
      onWheel={onSidebarWheel}
      variant="secondary"
      className="relative z-40 flex min-h-0 min-w-0 flex-col overflow-hidden rounded-none border-r border-neutral-800/60 bg-app-sidebar transition-[border-color,opacity] duration-200"
    >
      <div className="relative px-5 pt-14 pb-3">
        <div
          className="app-drag absolute inset-y-0 right-0"
          style={{
            left: `${titlebarSafeInset}px`
          }}
        />

        <div className="app-no-drag relative">
          <SidebarBreadcrumbs items={breadcrumbItems} />

          {sidebarMode === 'project' && groupedProjectsLabel ? (
            <SidebarProjectSelect
              groupName={groupedProjectsLabel}
              projects={groupedProjects}
              selectedProjectId={selectedProjectId}
              onSelectProject={(projectId) => {
                onSelectProject(projectId);
              }}
            />
          ) : null}

          {sidebarMode === 'root' ? (
            <>
              <Button
                data-testid="sidebar-home"
                fullWidth
                variant={isHomeSelected ? 'secondary' : 'ghost'}
                onPress={onOpenHome}
                className="mt-3 h-11 justify-start gap-3 rounded-xl px-3"
              >
                <House className="size-4" />
                Home
              </Button>

              <Button
                data-testid="sidebar-machines"
                fullWidth
                variant={isMachinesSelected ? 'secondary' : 'ghost'}
                onPress={onOpenMachines}
                className="mt-1 h-11 justify-start gap-3 rounded-xl px-3"
              >
                <Server className="size-4" />
                Machines
              </Button>

              <Button
                data-testid="sidebar-projects"
                fullWidth
                variant={isProjectsSelected ? 'secondary' : 'ghost'}
                onPress={onOpenProjects}
                className="mt-1 h-11 justify-start gap-3 rounded-xl px-3"
              >
                <FolderKanban className="size-4" />
                Projects
              </Button>
            </>
          ) : null}

          {sidebarMode === 'project' && project ? (
            <Text className="mt-2 block truncate px-3 text-xs font-medium text-neutral-600">
              {project.name}
            </Text>
          ) : null}
        </div>
      </div>

      {sidebarMode === 'machines' ? (
        <SidebarMachinesPicker connector={connectorOverview} onSelectMachine={onSelectMachine} />
      ) : sidebarMode === 'machine' ? (
        <div className="min-h-0 flex-1 px-8 py-2">
          {selectedMachine ? (
            <>
              <div className="mb-3 flex min-w-0 items-center gap-2">
                <MachineDeviceIcon machine={selectedMachine} />
                <Text className="truncate text-sm font-medium text-neutral-100">
                  {selectedMachine.name}
                </Text>
                <MachineOsMark machine={selectedMachine} />
              </div>
              <div className="space-y-2">
                <Text className="block text-sm text-neutral-500">
                  {formatMachineSubtitle(selectedMachine) || selectedMachine.connector.status}
                </Text>
                <div className="flex items-center gap-3">
                  <MachineConnectionIcon machine={selectedMachine} />
                  <MachineBatteryMeter compact machine={selectedMachine} />
                </div>
              </div>
            </>
          ) : (
            <Text className="block text-sm text-neutral-500">
              This machine is not currently in the connector registry.
            </Text>
          )}
        </div>
      ) : sidebarMode === 'project' && project ? (
        project.kind === 'github' ? (
          <div className="min-h-0 flex-1 px-8 py-2">
            <Text className="block text-sm font-medium text-neutral-300">
              GitHub repository
            </Text>
            <Text className="mt-1 block text-sm text-neutral-500">
              No local checkout is connected to this machine.
            </Text>
          </div>
        ) : (
          <div className="relative flex min-h-0 flex-1 overflow-hidden">
            <div ref={currentPanelRef} className="absolute inset-y-0 left-0 w-full">
              <SidebarContent
                onOpenNewWorktree={onOpenNewWorktree}
                onSelectWorkspace={onSelectWorkspace}
                onSelectWorktree={onSelectWorktree}
                onSidebarViewChange={onSidebarViewChange}
                project={project}
                selectedExplorerTarget={selectedExplorerTarget}
                sidebarView={sidebarView}
                worktrees={worktrees}
              />
            </div>

            {previewProject ? (
              <div ref={previewPanelRef} className="absolute inset-y-0 w-full">
                <SidebarContent
                  onOpenNewWorktree={() => undefined}
                  onSelectWorkspace={() => undefined}
                  onSelectWorktree={() => undefined}
                  onSidebarViewChange={() => undefined}
                  project={previewProject}
                  selectedExplorerTarget={{ kind: 'workspace' }}
                  sidebarView="workspace"
                  worktrees={previewWorktrees}
                />
              </div>
            ) : null}
          </div>
        )
      ) : sidebarMode === 'projects' ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <SidebarProjectPicker
            groups={groups}
            onSelectProject={(projectId) => onSelectProject(projectId)}
            projects={projects}
          />
        </div>
      ) : null}

      {sidebarMode === 'project' && navigationItems.length > 0 ? (
        <SpacesDock
          items={navigationItems.map((item) => ({
            id: item.id,
            kind: item.kind,
            label: item.label
          }))}
          activeItemId={activeNavigationItemId}
          canNavigateUp={false}
          groups={groups}
          onNavigateUp={undefined}
          onSelectProject={onSelectProject}
          onSelect={onSelectNavigationItem}
          onCreate={onCreateProject}
          projects={projects}
          rootItems={rootItems}
          selectedProjectId={selectedProjectId}
        />
      ) : null}

      {isOpen ? (
        <Button
          aria-label="Resize sidebar"
          isIconOnly
          variant="ghost"
          onMouseDown={onResizeStart}
          className="app-no-drag absolute top-0 right-0 h-full w-2 min-w-0 cursor-col-resize rounded-none px-0 opacity-0 transition hover:opacity-100"
        >
          <span className="absolute top-0 right-0 h-full w-px bg-neutral-600/70" />
        </Button>
      ) : null}
    </Surface>
  );
}
