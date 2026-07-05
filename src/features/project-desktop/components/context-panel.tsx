import { useMemo, useState } from 'react';
import { FolderGit2, GitBranchPlus, Pin, Plus } from 'lucide-react';
import {
  Button,
  Chip,
  ScrollShadow,
  SearchField,
  SearchFieldClearButton,
  SearchFieldGroup,
  SearchFieldInput,
  SearchFieldSearchIcon,
  Surface,
  Text
} from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import type {
  ConnectorOverviewResult,
  ExplorerTarget,
  MachineRecord,
  ProjectGroupRecord,
  ProjectSpaceRecord,
  ProjectWorktreeRecord
} from '@/shared/project-space-api';
import {
  isMachineConnected,
  MachineBatteryMeter,
  MachineConnectionIcon,
  MachineDeviceIcon,
  MachineOsMark
} from './machine-visuals';

function isVisibleProject(project: ProjectSpaceRecord) {
  const folder = project.rootPath.split('/').filter(Boolean).pop() ?? '';

  return !folder.startsWith('.') && !folder.endsWith('.worktrees');
}

function matchesSearch(value: string, query: string) {
  return value.toLowerCase().includes(query.trim().toLowerCase());
}

function formatMachineSubtitle(machine: MachineRecord) {
  return [machine.kind, machine.profile, machine.network.localName].filter(Boolean).join(' / ');
}

function getProjectOwner(
  project: ProjectSpaceRecord,
  groupsById: Record<string, ProjectGroupRecord>
) {
  if (project.github) {
    return `@${project.github.owner}`;
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

function PanelSearch({
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
    <SearchField aria-label={label} value={value} onChange={onChange}>
      <SearchFieldGroup className="rounded-lg bg-neutral-900/90">
        <SearchFieldSearchIcon />
        <SearchFieldInput className="text-sm" placeholder={placeholder} spellCheck={false} />
        <SearchFieldClearButton />
      </SearchFieldGroup>
    </SearchField>
  );
}

function PanelHeader({
  action,
  title
}: {
  action?: { label: string; onPress(): void };
  title: string;
}) {
  return (
    <div className="flex h-9 shrink-0 items-center justify-between gap-2 px-4">
      <Text className="text-xs font-semibold uppercase tracking-[0.14em] text-neutral-500">
        {title}
      </Text>
      {action ? (
        <Button
          aria-label={action.label}
          isIconOnly
          size="sm"
          title={action.label}
          variant="ghost"
          onPress={action.onPress}
          className="h-7 w-7 min-w-0 rounded-lg px-0 text-neutral-500 hover:text-neutral-100"
        >
          <Plus className="size-4" strokeWidth={1.8} />
        </Button>
      ) : null}
    </div>
  );
}

interface ProjectTargetRowsProps {
  onOpenNewWorktree(): void;
  onSelectWorkspace(): void;
  onSelectWorktree(worktreeId: string): void;
  selectedExplorerTarget: ExplorerTarget;
  worktrees: ProjectWorktreeRecord[];
}

function ProjectTargetRows({
  onOpenNewWorktree,
  onSelectWorkspace,
  onSelectWorktree,
  selectedExplorerTarget,
  worktrees
}: ProjectTargetRowsProps) {
  const isWorkspaceSelected = selectedExplorerTarget.kind === 'workspace';

  return (
    <div className="mt-0.5 mb-1 flex flex-col gap-0.5 border-l border-neutral-800/80 pl-3 ml-4">
      <button
        type="button"
        onClick={onSelectWorkspace}
        className={cn(
          'flex min-w-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] font-medium transition',
          isWorkspaceSelected
            ? 'bg-neutral-800/90 text-neutral-50'
            : 'text-neutral-400 hover:bg-neutral-800/60 hover:text-neutral-100'
        )}
      >
        <FolderGit2 className="size-3.5 shrink-0" strokeWidth={1.8} />
        <span className="min-w-0 flex-1 truncate">Workspace</span>
      </button>

      {worktrees.map((worktree) => {
        const isSelected =
          selectedExplorerTarget.kind === 'worktree' &&
          selectedExplorerTarget.worktreeId === worktree.id;
        const badge =
          worktree.status === 'broken' ? 'broken' : worktree.isBase ? 'base' : undefined;

        return (
          <button
            key={worktree.id}
            type="button"
            onClick={() => onSelectWorktree(worktree.id)}
            className={cn(
              'flex min-w-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] font-medium transition',
              isSelected
                ? 'bg-neutral-800/90 text-neutral-50'
                : worktree.status === 'broken'
                  ? 'text-amber-200/80 hover:bg-amber-500/10'
                  : 'text-neutral-400 hover:bg-neutral-800/60 hover:text-neutral-100'
            )}
          >
            <GitBranchPlus className="size-3.5 shrink-0" strokeWidth={1.8} />
            <span className="min-w-0 flex-1 truncate">{worktree.name}</span>
            {badge ? (
              <Chip
                color={badge === 'base' ? 'success' : 'warning'}
                size="sm"
                variant="soft"
                className="shrink-0 uppercase tracking-[0.14em]"
              >
                {badge}
              </Chip>
            ) : null}
          </button>
        );
      })}

      <button
        type="button"
        onClick={onOpenNewWorktree}
        className="flex min-w-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] font-medium text-neutral-600 transition hover:bg-neutral-800/60 hover:text-neutral-200"
      >
        <Plus className="size-3.5 shrink-0" strokeWidth={1.8} />
        New worktree
      </button>
    </div>
  );
}

interface ProjectsPanelProps {
  groups: ProjectGroupRecord[];
  onCreateProject(): void;
  onOpenNewWorktree(): void;
  onSelectProject(projectId: string, groupId?: string): void;
  onSelectWorkspace(): void;
  onSelectWorktree(worktreeId: string): void;
  onTogglePinnedProject(projectId: string): void;
  pinnedProjectIds: string[];
  projects: ProjectSpaceRecord[];
  selectedExplorerTarget: ExplorerTarget;
  selectedProjectId: string;
  worktrees: ProjectWorktreeRecord[];
}

function ProjectsPanel({
  groups,
  onCreateProject,
  onOpenNewWorktree,
  onSelectProject,
  onSelectWorkspace,
  onSelectWorktree,
  onTogglePinnedProject,
  pinnedProjectIds = [],
  projects,
  selectedExplorerTarget,
  selectedProjectId,
  worktrees
}: ProjectsPanelProps) {
  const [query, setQuery] = useState('');
  const groupsById = useMemo(
    () =>
      groups.reduce<Record<string, ProjectGroupRecord>>((index, group) => {
        index[group.id] = group;
        return index;
      }, {}),
    [groups]
  );
  const pinnedProjectIdSet = useMemo(() => new Set(pinnedProjectIds), [pinnedProjectIds]);
  const projectsById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects]
  );
  const projectMatchesQuery = (project: ProjectSpaceRecord) => {
    const owner = getProjectOwner(project, groupsById);
    const label = getProjectLabel(project, owner);

    return (
      !query.trim() ||
      matchesSearch(`${owner} ${label} ${project.name} ${project.rootPath}`, query) ||
      project.id === selectedProjectId
    );
  };
  const pinnedProjects = useMemo(() => {
    return pinnedProjectIds
      .map((projectId) => projectsById.get(projectId))
      .filter((project): project is ProjectSpaceRecord => {
        if (!project) {
          return false;
        }

        return isVisibleProject(project) && projectMatchesQuery(project);
      });
  }, [groupsById, pinnedProjectIds, projectsById, query, selectedProjectId]);
  const projectGroups = useMemo(() => {
    const byOwner = new Map<string, ProjectSpaceRecord[]>();

    for (const project of projects.filter(isVisibleProject)) {
      if (pinnedProjectIdSet.has(project.id)) {
        continue;
      }

      const owner = getProjectOwner(project, groupsById);

      if (!projectMatchesQuery(project)) {
        continue;
      }

      byOwner.set(owner, [...(byOwner.get(owner) ?? []), project]);
    }

    return Array.from(byOwner.entries())
      .map(([owner, entries]) => ({
        entries: [...entries].sort((left, right) =>
          getProjectLabel(left, owner).localeCompare(getProjectLabel(right, owner))
        ),
        owner
      }))
      .sort((left, right) => left.owner.localeCompare(right.owner));
  }, [groupsById, pinnedProjectIdSet, projects, query, selectedProjectId]);

  const renderProjectRow = (entry: ProjectSpaceRecord, owner: string) => {
    const isPinned = pinnedProjectIdSet.has(entry.id);
    const isSelected = entry.id === selectedProjectId;
    const showTargets = isSelected && entry.kind !== 'github' && entry.rootPath !== '';
    const label = getProjectLabel(entry, owner);

    return (
      <div key={entry.id}>
        <div
          className={cn(
            'group/project-row flex min-w-0 items-center rounded-lg transition',
            isSelected
              ? 'bg-neutral-800/90 text-neutral-50'
              : 'text-neutral-300 hover:bg-neutral-800/60 hover:text-neutral-50'
          )}
        >
          <button
            type="button"
            onClick={() => onSelectProject(entry.id)}
            aria-current={isSelected ? 'true' : undefined}
            className="flex min-w-0 flex-1 items-center px-2.5 py-2 text-left text-sm font-medium"
          >
            <span className="min-w-0 flex-1 truncate">{label}</span>
          </button>
          <button
            type="button"
            aria-label={`${isPinned ? 'Unpin' : 'Pin'} ${label}`}
            aria-pressed={isPinned}
            title={`${isPinned ? 'Unpin' : 'Pin'} ${label}`}
            onClick={() => onTogglePinnedProject(entry.id)}
            className={cn(
              'mr-1 flex size-7 shrink-0 items-center justify-center rounded-md transition',
              isPinned
                ? 'text-neutral-100 hover:bg-neutral-700/80'
                : 'text-neutral-500 opacity-0 hover:bg-neutral-700/70 hover:text-neutral-100 group-hover/project-row:opacity-100 focus-visible:opacity-100'
            )}
          >
            <Pin className="size-3.5" fill={isPinned ? 'currentColor' : 'none'} strokeWidth={1.8} />
          </button>
        </div>

        {showTargets ? (
          <ProjectTargetRows
            onOpenNewWorktree={onOpenNewWorktree}
            onSelectWorkspace={onSelectWorkspace}
            onSelectWorktree={onSelectWorktree}
            selectedExplorerTarget={selectedExplorerTarget}
            worktrees={worktrees}
          />
        ) : null}
      </div>
    );
  };

  return (
    <>
      <PanelHeader
        title="Projects"
        action={{ label: 'Add project directory', onPress: onCreateProject }}
      />
      <div className="shrink-0 px-3 pb-2">
        <PanelSearch
          label="Search projects"
          placeholder="Search projects"
          value={query}
          onChange={setQuery}
        />
      </div>

      <ScrollShadow className="min-h-0 flex-1 px-3 pb-3" hideScrollBar>
        {pinnedProjects.length > 0 ? (
          <div className="mb-3">
            <Text className="mb-1 block px-2.5 text-xs font-medium text-neutral-600">
              Pinned
            </Text>
            {pinnedProjects.map((entry) =>
              renderProjectRow(entry, getProjectOwner(entry, groupsById))
            )}
          </div>
        ) : null}

        {projectGroups.map((group) => (
          <div key={group.owner} className="mb-2 last:mb-0">
            <Text className="mb-1 block px-2.5 text-xs font-medium text-neutral-600">
              {group.owner}
            </Text>
            {group.entries.map((entry) => renderProjectRow(entry, group.owner))}
          </div>
        ))}

        {projectGroups.length === 0 && pinnedProjects.length === 0 ? (
          <Text className="px-2.5 py-2 text-sm text-neutral-500">
            {projects.filter(isVisibleProject).length === 0
              ? 'No projects yet. Add one with the + button above.'
              : 'No projects found.'}
          </Text>
        ) : null}
      </ScrollShadow>
    </>
  );
}

function MachineRow({
  isSelected,
  machine,
  onSelectMachine
}: {
  isSelected: boolean;
  machine: MachineRecord;
  onSelectMachine(machineId: string): void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelectMachine(machine.id)}
      aria-current={isSelected ? 'true' : undefined}
      className={cn(
        'flex min-w-0 items-center gap-3 rounded-lg px-2.5 py-2 text-left transition',
        isSelected ? 'bg-neutral-800/90' : 'hover:bg-neutral-800/60'
      )}
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

interface MachinesPanelProps {
  connectorOverview: ConnectorOverviewResult;
  onSelectMachine(machineId: string): void;
  selectedMachineId: string;
}

function MachinesPanel({
  connectorOverview,
  onSelectMachine,
  selectedMachineId
}: MachinesPanelProps) {
  const [query, setQuery] = useState('');
  const machines = useMemo(() => {
    return connectorOverview.machines.filter((machine) => {
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
  }, [connectorOverview.machines, query]);
  const connectedMachines = machines.filter(isMachineConnected);
  const disconnectedMachines = machines.filter((machine) => !isMachineConnected(machine));

  function renderSection(title: string, sectionMachines: MachineRecord[]) {
    if (sectionMachines.length === 0) {
      return null;
    }

    return (
      <div className="mb-3 last:mb-0">
        <Text className="mb-1 block px-2.5 text-xs font-medium text-neutral-600">{title}</Text>
        <div className="flex flex-col gap-0.5">
          {sectionMachines.map((machine) => (
            <MachineRow
              key={machine.id}
              isSelected={machine.id === selectedMachineId}
              machine={machine}
              onSelectMachine={onSelectMachine}
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <>
      <PanelHeader title="Machines" />
      <div className="shrink-0 px-3 pb-2">
        <PanelSearch
          label="Search machines"
          placeholder="Search machines"
          value={query}
          onChange={setQuery}
        />
      </div>

      <ScrollShadow className="min-h-0 flex-1 px-3 pb-3" hideScrollBar>
        {renderSection('Connected', connectedMachines)}
        {renderSection('Disconnected', disconnectedMachines)}

        {machines.length === 0 ? (
          <Text className="px-2.5 py-2 text-sm text-neutral-500">No machines found.</Text>
        ) : null}
      </ScrollShadow>
    </>
  );
}

export interface ContextPanelProps {
  connectorOverview: ConnectorOverviewResult;
  groups: ProjectGroupRecord[];
  onCreateProject(): void;
  onOpenNewWorktree(): void;
  onResizeStart(event: React.MouseEvent<HTMLButtonElement>): void;
  onSelectMachine(machineId: string): void;
  onSelectProject(projectId: string, groupId?: string): void;
  onSelectWorkspace(): void;
  onSelectWorktree(worktreeId: string): void;
  onTogglePinnedProject(projectId: string): void;
  pinnedProjectIds: string[];
  projects: ProjectSpaceRecord[];
  section: 'projects' | 'machines';
  selectedExplorerTarget: ExplorerTarget;
  selectedMachineId: string;
  selectedProjectId: string;
  worktrees: ProjectWorktreeRecord[];
}

export function ContextPanel({
  connectorOverview,
  groups,
  onCreateProject,
  onOpenNewWorktree,
  onResizeStart,
  onSelectMachine,
  onSelectProject,
  onSelectWorkspace,
  onSelectWorktree,
  onTogglePinnedProject,
  pinnedProjectIds,
  projects,
  section,
  selectedExplorerTarget,
  selectedMachineId,
  selectedProjectId,
  worktrees
}: ContextPanelProps) {
  return (
    <Surface
      variant="secondary"
      className="relative z-40 flex min-h-0 min-w-0 flex-col overflow-hidden rounded-none border-r border-neutral-800/60 bg-app-sidebar"
    >
      <div className="app-drag h-14 shrink-0" />

      {section === 'projects' ? (
        <ProjectsPanel
          groups={groups}
          onCreateProject={onCreateProject}
          onOpenNewWorktree={onOpenNewWorktree}
          onSelectProject={onSelectProject}
          onSelectWorkspace={onSelectWorkspace}
          onSelectWorktree={onSelectWorktree}
          onTogglePinnedProject={onTogglePinnedProject}
          pinnedProjectIds={pinnedProjectIds}
          projects={projects}
          selectedExplorerTarget={selectedExplorerTarget}
          selectedProjectId={selectedProjectId}
          worktrees={worktrees}
        />
      ) : (
        <MachinesPanel
          connectorOverview={connectorOverview}
          onSelectMachine={onSelectMachine}
          selectedMachineId={selectedMachineId}
        />
      )}

      <Button
        aria-label="Resize sidebar"
        isIconOnly
        variant="ghost"
        onMouseDown={onResizeStart}
        className="app-no-drag absolute top-0 right-0 h-full w-2 min-w-0 cursor-col-resize rounded-none px-0 opacity-0 transition hover:opacity-100"
      >
        <span className="absolute top-0 right-0 h-full w-px bg-neutral-600/70" />
      </Button>
    </Surface>
  );
}
