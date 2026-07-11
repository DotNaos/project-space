import type { ProjectsState } from '../../src/shared/project-space-api';

const maximumIdentifierLength = 2_048;
const maximumPinnedProjects = 256;
const maximumRecentProjects = 8;

export function emptyProjectsState(): ProjectsState {
  return {
    activeGroupId: '',
    pinnedProjectIds: [],
    recentProjectIds: [],
    selectedExplorerTarget: { kind: 'workspace' },
    selectedLauncherAppId: '',
    selectedProjectId: ''
  };
}

function requireIdentifier(value: unknown, name: string) {
  if (typeof value !== 'string' || value.length > maximumIdentifierLength) {
    throw new Error(`${name} must be a string of at most ${maximumIdentifierLength} characters.`);
  }

  return value;
}

function requireIdentifierList(value: unknown, name: string, maximumItems: number) {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new Error(`${name} must contain at most ${maximumItems} project identifiers.`);
  }

  return [
    ...new Set(value.map((entry, index) => requireIdentifier(entry, `${name}[${index}]`)))
  ];
}

export function normalizeProjectsState(value: unknown): ProjectsState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Projects state must be an object.');
  }

  const state = value as Record<string, unknown>;
  const target = state.selectedExplorerTarget;
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw new Error('selectedExplorerTarget must be an object.');
  }

  const targetRecord = target as Record<string, unknown>;
  const selectedExplorerTarget =
    targetRecord.kind === 'workspace'
      ? ({ kind: 'workspace' } as const)
      : targetRecord.kind === 'worktree'
        ? ({
            kind: 'worktree',
            worktreeId: requireIdentifier(
              targetRecord.worktreeId,
              'selectedExplorerTarget.worktreeId'
            )
          } as const)
        : undefined;

  if (!selectedExplorerTarget) {
    throw new Error('selectedExplorerTarget.kind must be workspace or worktree.');
  }

  return {
    activeGroupId: requireIdentifier(state.activeGroupId, 'activeGroupId'),
    pinnedProjectIds: requireIdentifierList(
      state.pinnedProjectIds,
      'pinnedProjectIds',
      maximumPinnedProjects
    ),
    recentProjectIds: requireIdentifierList(
      state.recentProjectIds,
      'recentProjectIds',
      maximumRecentProjects
    ),
    selectedExplorerTarget,
    selectedLauncherAppId: requireIdentifier(
      state.selectedLauncherAppId,
      'selectedLauncherAppId'
    ),
    selectedProjectId: requireIdentifier(state.selectedProjectId, 'selectedProjectId')
  };
}
