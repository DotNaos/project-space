import { useState } from 'react';
import type {
  MachineRecord,
  ProjectSpaceRecord,
  ProjectStructureActionRequest,
  ProjectStructureActionType,
  ProjectTrashEntryRecord,
  ProjectStructureViolationRecord
} from '@/shared/project-space-api';
import { projectSpaceClient } from '@/api/project-space-client';
import {
  SearchField,
  SearchFieldClearButton,
  SearchFieldGroup,
  SearchFieldInput,
  SearchFieldSearchIcon,
  Text
} from '@/app/dotnaos-ui';
import {
  Archive,
  ArchiveRestore,
  Copy,
  FolderOpen,
  MoreHorizontal,
  RefreshCw,
  Wrench,
  X
} from 'lucide-react';
import { getProjectMachineId, isVisibleProject } from './project-main-model';
import {
  machineIdForViolation,
  StructureViolationRow
} from './machine-project-violations';
import {
  codexSystemPromptForViolations,
  fixOptionsForProject,
  fixOptionsForViolation,
  matchesMachineProjectQuery,
  matchesViolationQuery,
  projectViolationTone,
  projectsRootFromViolations,
  type ViolationFixOption
} from './machine-project-actions';
import { MachineProjectsCodexChat } from './machine-projects-codex-chat';

export function MachineProjectsPanel({
  localMachineId,
  machine,
  onRefreshProjectDiscovery,
  onSelectProject,
  projects,
  structureViolations
}: {
  localMachineId: string;
  machine: MachineRecord;
  onRefreshProjectDiscovery(): Promise<unknown>;
  onSelectProject(projectId: string): void;
  projects: ProjectSpaceRecord[];
  structureViolations: ProjectStructureViolationRecord[];
}) {
  const [busyViolationId, setBusyViolationId] = useState('');
  const [openFixViolationId, setOpenFixViolationId] = useState('');
  const [isLoadingTrash, setIsLoadingTrash] = useState(false);
  const [isTrashOpen, setIsTrashOpen] = useState(false);
  const [busyProjectAction, setBusyProjectAction] = useState<ProjectStructureActionType | ''>('');
  const [busyTrashPath, setBusyTrashPath] = useState('');
  const [openProjectMenuId, setOpenProjectMenuId] = useState('');
  const [projectActionMessage, setProjectActionMessage] = useState('');
  const [projectQuery, setProjectQuery] = useState('');
  const [trashEntries, setTrashEntries] = useState<ProjectTrashEntryRecord[]>([]);
  const [trashMessage, setTrashMessage] = useState('');
  const [violationActionMessage, setViolationActionMessage] = useState('');
  const machineProjects = projects
    .filter(isVisibleProject)
    .filter((project) => project.kind !== 'github')
    .filter((project) => getProjectMachineId(project, localMachineId) === machine.id)
    .sort((left, right) => left.name.localeCompare(right.name));
  const machineViolations = structureViolations
    .filter((violation) => machineIdForViolation(violation, localMachineId) === machine.id)
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const projectNames = new Set(machineProjects.map((project) => project.name));
  const violationsByProjectName = new Map<string, ProjectStructureViolationRecord[]>();
  const looseViolations: ProjectStructureViolationRecord[] = [];

  for (const violation of machineViolations) {
    if (violation.projectName && projectNames.has(violation.projectName)) {
      const existing = violationsByProjectName.get(violation.projectName) ?? [];
      existing.push(violation);
      violationsByProjectName.set(violation.projectName, existing);
    } else {
      looseViolations.push(violation);
    }
  }
  const filteredMachineProjects = machineProjects.filter((project) =>
    matchesMachineProjectQuery({
      project,
      query: projectQuery,
      violations: violationsByProjectName.get(project.name) ?? []
    })
  );
  const filteredLooseViolations = looseViolations.filter((violation) =>
    matchesViolationQuery(violation, projectQuery)
  );
  const visibleViolationIds = new Set<string>();
  const visibleViolationsForCodex = [
    ...filteredMachineProjects.flatMap((project) =>
      violationsByProjectName.get(project.name) ?? []
    ),
    ...filteredLooseViolations
  ].filter((violation) => {
    if (visibleViolationIds.has(violation.id)) {
      return false;
    }

    visibleViolationIds.add(violation.id);
    return true;
  });
  const projectsRoot = projectsRootFromViolations(machineViolations);
  const activeFixViolation =
    machineViolations.find((violation) => violation.id === openFixViolationId) ?? null;
  const activeProjectMenu =
    machineProjects.find((project) => project.id === openProjectMenuId) ?? null;
  const codexSystemPrompt = codexSystemPromptForViolations({
    machine,
    query: projectQuery,
    visibleViolations: visibleViolationsForCodex,
    violations: machineViolations
  });

  async function runViolationAction(
    violation: ProjectStructureViolationRecord,
    action: ProjectStructureActionType
  ) {
    if (
      action === 'move_to_trash' &&
      !window.confirm(
        `Move ${violation.name} to Project Space archive?\n\nIt can be inspected and restored from this page.`
      )
    ) {
      return;
    }

    setBusyViolationId(violation.id);
    setViolationActionMessage('');

    try {
      const result = await projectSpaceClient.applyProjectStructureAction({
        action,
        path: violation.path,
        type: violation.type
      });

      if (result.status !== 'success') {
        setViolationActionMessage(result.message);
        return;
      }

      await onRefreshProjectDiscovery();
      if (isTrashOpen) {
        await loadTrash();
      }
      setOpenFixViolationId('');
      setViolationActionMessage(result.message);
    } catch (error) {
      setViolationActionMessage(error instanceof Error ? error.message : 'Action failed.');
    } finally {
      setBusyViolationId('');
    }
  }

  async function applyGeneratedCodexAction(request: ProjectStructureActionRequest) {
    const result = await projectSpaceClient.applyProjectStructureAction(request);

    if (result.status !== 'success') {
      throw new Error(result.message);
    }

    await onRefreshProjectDiscovery();
    return result.message;
  }

  async function loadTrash() {
    setIsLoadingTrash(true);
    setTrashMessage('');

    try {
      const result = await projectSpaceClient.listProjectTrash();
      setTrashEntries(result.entries);
    } catch (error) {
      setTrashMessage(error instanceof Error ? error.message : 'Could not load archive.');
    } finally {
      setIsLoadingTrash(false);
    }
  }

  async function toggleTrash() {
    const nextIsOpen = !isTrashOpen;
    setIsTrashOpen(nextIsOpen);

    if (nextIsOpen) {
      await loadTrash();
    }
  }

  async function restoreTrashEntry(entry: ProjectTrashEntryRecord) {
    if (
      !window.confirm(`Restore ${entry.name} to ${entry.originalRelativePath}?`)
    ) {
      return;
    }

    setBusyTrashPath(entry.trashPath);
    setTrashMessage('');

    try {
      const result = await projectSpaceClient.restoreProjectTrashEntry({
        trashPath: entry.trashPath
      });

      setTrashMessage(result.message);

      if (result.status === 'success') {
        await loadTrash();
        await onRefreshProjectDiscovery();
      }
    } catch (error) {
      setTrashMessage(error instanceof Error ? error.message : 'Restore failed.');
    } finally {
      setBusyTrashPath('');
    }
  }

  async function copyProjectPath(project: ProjectSpaceRecord) {
    try {
      await navigator.clipboard.writeText(project.rootPath);
      setProjectActionMessage(`Copied ${project.name} path.`);
      setOpenProjectMenuId('');
    } catch (error) {
      setProjectActionMessage(error instanceof Error ? error.message : 'Could not copy path.');
    }
  }

  async function runProjectFixAction(project: ProjectSpaceRecord, option: ViolationFixOption) {
    if (option.disabledReason) {
      return;
    }

    if (
      option.action === 'move_to_trash' &&
      !window.confirm(
        `Move ${project.name} to Project Space archive?\n\nIt can be inspected and restored from this page.`
      )
    ) {
      return;
    }

    setBusyProjectAction(option.action);
    setProjectActionMessage('');

    try {
      const result = await projectSpaceClient.applyProjectStructureAction({
        action: option.action,
        path: project.rootPath,
        type: option.requestType
      });

      setProjectActionMessage(result.message);

      if (result.status === 'success') {
        await onRefreshProjectDiscovery();
        if (isTrashOpen) {
          await loadTrash();
        }
        setOpenProjectMenuId('');
      }
    } catch (error) {
      setProjectActionMessage(error instanceof Error ? error.message : 'Action failed.');
    } finally {
      setBusyProjectAction('');
    }
  }

  function renderProjectMenuModal() {
    if (!activeProjectMenu) {
      return null;
    }

    const projectViolations = violationsByProjectName.get(activeProjectMenu.name) ?? [];
    const projectFixOptions = fixOptionsForProject(activeProjectMenu, projectViolations);

    return (
      <div
        className="fixed inset-0 z-[60] flex items-end justify-center bg-black/65 px-3 py-4 sm:items-center sm:px-4 sm:py-6"
        onClick={() => {
          if (!busyProjectAction) {
            setOpenProjectMenuId('');
          }
        }}
      >
        <div
          className="flex max-h-[min(38rem,calc(100vh-2rem))] w-full max-w-md flex-col rounded-t-lg border border-neutral-800 bg-neutral-950 shadow-2xl sm:rounded-lg"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="flex items-start justify-between gap-3 border-b border-neutral-900 px-4 py-3">
            <div className="min-w-0">
              <Text className="text-sm font-semibold text-neutral-100">
                {activeProjectMenu.name}
              </Text>
              <Text className="mt-1 block truncate text-xs text-neutral-500">
                {activeProjectMenu.rootPath}
              </Text>
            </div>
            <button
              type="button"
              aria-label="Close project menu"
              disabled={Boolean(busyProjectAction)}
              onClick={() => setOpenProjectMenuId('')}
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-neutral-400 transition hover:bg-neutral-900 hover:text-neutral-100 disabled:pointer-events-none disabled:opacity-50"
            >
              <X className="size-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            <button
              type="button"
              disabled={Boolean(busyProjectAction)}
              onClick={() => {
                setOpenProjectMenuId('');
                onSelectProject(activeProjectMenu.id);
              }}
              className="w-full rounded-lg px-3 py-3 text-left transition hover:bg-neutral-900 disabled:pointer-events-none disabled:opacity-50"
            >
              <span className="flex min-w-0 items-center gap-3">
                <FolderOpen className="size-4 shrink-0 text-neutral-400" />
                <span className="text-sm font-medium text-neutral-200">Open project</span>
              </span>
            </button>
            <button
              type="button"
              disabled={Boolean(busyProjectAction)}
              onClick={() => void copyProjectPath(activeProjectMenu)}
              className="w-full rounded-lg px-3 py-3 text-left transition hover:bg-neutral-900 disabled:pointer-events-none disabled:opacity-50"
            >
              <span className="flex min-w-0 items-center gap-3">
                <Copy className="size-4 shrink-0 text-neutral-400" />
                <span className="text-sm font-medium text-neutral-200">Copy path</span>
              </span>
            </button>
            <div className="my-2 border-t border-neutral-900" />
            <Text className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-neutral-600">
              Fix
            </Text>
            {projectFixOptions.map((option) => {
              const Icon = option.icon;
              const isBusy = busyProjectAction === option.action;

              return (
                <button
                  type="button"
                  key={option.action}
                  disabled={Boolean(busyProjectAction) || Boolean(option.disabledReason)}
                  onClick={() => void runProjectFixAction(activeProjectMenu, option)}
                  className="w-full rounded-lg px-3 py-3 text-left transition hover:bg-neutral-900 disabled:pointer-events-none disabled:opacity-45"
                >
                  <div className="flex min-w-0 items-start gap-3">
                    <Icon className="mt-0.5 size-4 shrink-0 text-neutral-400" />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-neutral-200">
                        {isBusy ? 'Working...' : option.label}
                      </span>
                      <span className="mt-1 block text-xs leading-4 text-neutral-500">
                        {option.disabledReason ?? option.description}
                      </span>
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  function renderArchiveModal() {
    if (!isTrashOpen) {
      return null;
    }

    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 px-4 py-6">
        <div className="flex max-h-[min(42rem,calc(100vh-3rem))] w-full max-w-2xl flex-col rounded-lg border border-neutral-800 bg-neutral-950 shadow-2xl">
          <div className="flex items-start justify-between gap-3 border-b border-neutral-900 px-4 py-3">
            <div className="min-w-0">
              <Text className="text-sm font-semibold text-neutral-100">Project archive</Text>
              <Text className="mt-1 block text-xs text-neutral-500">
                Items moved from ~/projects can be restored here.
              </Text>
            </div>
            <button
              type="button"
              aria-label="Close archive"
              onClick={() => setIsTrashOpen(false)}
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-neutral-400 transition hover:bg-neutral-900 hover:text-neutral-100"
            >
              <X className="size-4" />
            </button>
          </div>
          <div className="flex items-center justify-between gap-2 px-4 py-3">
            <Text className="text-xs text-neutral-500">
              {trashEntries.length} archived {trashEntries.length === 1 ? 'item' : 'items'}
            </Text>
            <button
              type="button"
              disabled={isLoadingTrash}
              onClick={() => void loadTrash()}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-neutral-800 px-2.5 py-1.5 text-xs text-neutral-300 transition hover:bg-neutral-900 disabled:pointer-events-none disabled:opacity-50"
            >
              <RefreshCw className={`size-3.5 ${isLoadingTrash ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
            {trashMessage ? (
              <Text className="mb-2 block text-xs text-neutral-500">{trashMessage}</Text>
            ) : null}
            {isLoadingTrash && trashEntries.length === 0 ? (
              <Text className="block py-6 text-sm text-neutral-500">Loading archive...</Text>
            ) : trashEntries.length === 0 ? (
              <Text className="block py-6 text-sm text-neutral-500">Archive is empty.</Text>
            ) : (
              <div className="divide-y divide-neutral-900">
                {trashEntries.map((entry) => {
                  const isBusy = busyTrashPath === entry.trashPath;

                  return (
                    <div
                      key={entry.id}
                      className="flex min-w-0 items-center justify-between gap-3 py-3"
                    >
                      <span className="min-w-0">
                        <Text className="block truncate text-sm font-medium text-neutral-200">
                          {entry.name}
                        </Text>
                        <Text className="block truncate text-xs text-neutral-500">
                          {entry.originalRelativePath}
                        </Text>
                      </span>
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => void restoreTrashEntry(entry)}
                        className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-neutral-800 px-2.5 py-1.5 text-xs font-medium text-neutral-200 transition hover:bg-neutral-900 disabled:pointer-events-none disabled:opacity-50"
                      >
                        <ArchiveRestore className="size-3.5" />
                        {isBusy ? 'Restoring...' : 'Restore'}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  function renderFixModal() {
    if (!activeFixViolation) {
      return null;
    }

    const isBusy = busyViolationId === activeFixViolation.id;
    const options = fixOptionsForViolation(activeFixViolation);

    if (options.length === 0) {
      return null;
    }

    return (
      <div
        className="fixed inset-0 z-[60] flex items-end justify-center bg-black/65 px-3 py-4 sm:items-center sm:px-4 sm:py-6"
        onClick={() => {
          if (!isBusy) {
            setOpenFixViolationId('');
          }
        }}
      >
        <div
          className="flex max-h-[min(34rem,calc(100vh-2rem))] w-full max-w-lg flex-col rounded-t-lg border border-neutral-800 bg-neutral-950 shadow-2xl sm:rounded-lg"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="flex items-start justify-between gap-3 border-b border-neutral-900 px-4 py-3">
            <div className="min-w-0">
              <Text className="text-sm font-semibold text-neutral-100">Fix violation</Text>
              <Text className="mt-1 block truncate text-xs text-neutral-500">
                {activeFixViolation.name} · {activeFixViolation.title}
              </Text>
            </div>
            <button
              type="button"
              aria-label="Close fix options"
              disabled={isBusy}
              onClick={() => setOpenFixViolationId('')}
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-neutral-400 transition hover:bg-neutral-900 hover:text-neutral-100 disabled:pointer-events-none disabled:opacity-50"
            >
              <X className="size-4" />
            </button>
          </div>
          <div className="border-b border-neutral-900 px-4 py-3">
            <Text className="block truncate font-mono text-xs text-neutral-500">
              {activeFixViolation.relativePath}
            </Text>
            <Text className="mt-2 block text-xs leading-5 text-neutral-500">
              {activeFixViolation.detail}
            </Text>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {options.map((option) => {
              const Icon = option.icon;

              return (
                <button
                  type="button"
                  key={option.action}
                  disabled={isBusy || Boolean(option.disabledReason)}
                  onClick={() => void runViolationAction(activeFixViolation, option.action)}
                  className="w-full rounded-lg px-3 py-3 text-left transition hover:bg-neutral-900 disabled:pointer-events-none disabled:opacity-45"
                >
                  <div className="flex min-w-0 items-start gap-3">
                    <Icon className="mt-0.5 size-4 shrink-0 text-neutral-400" />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-neutral-200">
                        {option.label}
                      </span>
                      <span className="mt-1 block text-xs leading-4 text-neutral-500">
                        {option.disabledReason ?? option.description}
                      </span>
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  function renderViolationActions(violation: ProjectStructureViolationRecord) {
    const isBusy = busyViolationId === violation.id;
    const isOpen = openFixViolationId === violation.id;
    const options = fixOptionsForViolation(violation);

    if (options.length === 0) {
      return null;
    }

    return (
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-label={`Fix ${violation.name}`}
        disabled={isBusy}
        onClick={() => setOpenFixViolationId(isOpen ? '' : violation.id)}
        className="inline-flex items-center justify-center gap-1.5 rounded-md border border-neutral-800 bg-neutral-900/70 px-2.5 py-1.5 text-xs font-medium text-neutral-200 transition hover:border-neutral-700 hover:bg-neutral-800 disabled:pointer-events-none disabled:opacity-50"
      >
        <Wrench className="size-3.5" />
        {isBusy ? 'Fixing...' : 'Fix'}
      </button>
    );
  }

  return (
    <section>
      <div className="mb-2 flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        <div>
          <Text className="text-sm font-semibold text-neutral-100">Projects on this machine</Text>
          <Text className="mt-1 block text-xs text-neutral-500">Root ~/projects</Text>
        </div>
        <div className="flex w-full items-center justify-between gap-2 sm:w-auto sm:justify-end">
          <button
            type="button"
            aria-expanded={isTrashOpen}
            onClick={() => void toggleTrash()}
            className="inline-flex items-center gap-1.5 rounded-md border border-neutral-800 px-2.5 py-1.5 text-xs font-medium text-neutral-300 transition hover:bg-neutral-900"
          >
            <Archive className="size-3.5" />
            Archive
            {trashEntries.length > 0 ? (
              <span className="text-neutral-500">{trashEntries.length}</span>
            ) : null}
          </button>
          {machineViolations.length > 0 ? (
            <span className="rounded-full border border-red-500/25 bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-200">
              {machineViolations.length} violations
            </span>
          ) : null}
          <Text className="shrink-0 whitespace-nowrap text-xs text-neutral-500">
            {projectQuery.trim()
              ? `${filteredMachineProjects.length + filteredLooseViolations.length}/${machineProjects.length + looseViolations.length}`
              : machineProjects.length}
          </Text>
        </div>
      </div>
      <SearchField
        aria-label="Search projects on this machine"
        value={projectQuery}
        onChange={setProjectQuery}
        className="mb-3"
      >
        <SearchFieldGroup className="rounded-lg bg-neutral-900/90">
          <SearchFieldSearchIcon />
          <SearchFieldInput placeholder="Search projects" />
          <SearchFieldClearButton />
        </SearchFieldGroup>
      </SearchField>
      {violationActionMessage ? (
        <Text className="mb-2 block text-xs text-neutral-500">{violationActionMessage}</Text>
      ) : null}
      {projectActionMessage ? (
        <Text className="mb-2 block text-xs text-neutral-500">{projectActionMessage}</Text>
      ) : null}
      {renderArchiveModal()}
      {renderFixModal()}
      {renderProjectMenuModal()}
      <div className="grid min-h-0 gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="min-w-0">
          {filteredMachineProjects.length > 0 || filteredLooseViolations.length > 0 ? (
            <div className="flex flex-col divide-y divide-neutral-900/80">
              {filteredMachineProjects.map((project) => {
                const projectViolations = violationsByProjectName.get(project.name) ?? [];
                const gitStatus = project.gitStatus;
                const hasUnstagedChanges = Boolean(gitStatus?.hasUnstagedChanges);
                const firstViolation = projectViolations[0];
                const violationTone =
                  projectViolations.length > 0 ? projectViolationTone(projectViolations) : null;
                const ViolationIcon = violationTone?.icon;

                return (
                  <div key={project.id} className="min-w-0 rounded-lg">
                    <div className="flex min-w-0 items-center gap-2 rounded-lg transition hover:bg-neutral-900/50">
                      <button
                        type="button"
                        title={project.rootPath}
                        onClick={() => onSelectProject(project.id)}
                        className="flex min-w-0 flex-1 items-center gap-3 px-3 py-3 text-left"
                      >
                        {ViolationIcon ? (
                          <ViolationIcon
                            className={`size-4 shrink-0 ${violationTone.text}`}
                          />
                        ) : (
                          <span className="size-4 shrink-0" />
                        )}
                        <span className="min-w-0 flex-1">
                          <Text className="block truncate text-sm font-medium text-neutral-100">
                            {project.name}
                          </Text>
                          <Text className="block truncate text-xs text-neutral-500">
                            main worktree{gitStatus?.branchName ? ` · ${gitStatus.branchName}` : ''}
                            {firstViolation ? ` · ${firstViolation.title}` : ''}
                          </Text>
                        </span>
                      </button>
                      <div className="flex shrink-0 items-center gap-1.5 pr-2">
                        {hasUnstagedChanges ? (
                          <span className="rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-200">
                            {gitStatus?.unstaged} unstaged
                          </span>
                        ) : null}
                        {projectViolations.length > 0 ? (
                          <span className="rounded-full border border-red-500/25 bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-200">
                            {projectViolations.length}
                          </span>
                        ) : null}
                        <button
                          type="button"
                          aria-haspopup="dialog"
                          aria-label={`Project options for ${project.name}`}
                          onClick={() => {
                            setProjectActionMessage('');
                            setOpenProjectMenuId(project.id);
                          }}
                          className="inline-flex size-8 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-900 hover:text-neutral-100"
                        >
                          <MoreHorizontal className="size-4" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
              {filteredLooseViolations.map((violation) => (
                <StructureViolationRow
                  key={violation.id}
                  actions={renderViolationActions(violation)}
                  violation={violation}
                />
              ))}
            </div>
          ) : (
            <div className="rounded-lg bg-neutral-950/45 px-4 py-6">
              <Text className="text-sm text-neutral-500">
                {projectQuery.trim()
                  ? 'No projects match this search.'
                  : 'No local projects reported by this machine yet.'}
              </Text>
            </div>
          )}
        </div>
        {machineViolations.length > 0 && projectsRoot ? (
          <MachineProjectsCodexChat
            cwd={projectsRoot}
            machine={machine}
            onApplyAction={applyGeneratedCodexAction}
            systemPrompt={codexSystemPrompt}
            violations={machineViolations}
          />
        ) : null}
      </div>
    </section>
  );
}
