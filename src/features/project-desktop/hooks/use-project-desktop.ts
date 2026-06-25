import { useEffect, useMemo, useState } from 'react';
import { projectSpaceClient } from '@/api/project-space-client';
import { launcherAppLabels } from '@/shared/project-space-api';
import type {
  ExplorerTarget,
  LauncherAppRecord,
  ProjectDiscoveryResult,
  ProjectNavigationItem,
  ProjectSpaceRecord,
  ProjectsState,
  ProjectWorktreeRecord
} from '@/shared/project-space-api';
import type { SidebarView } from '../components/sidebar-view-tabs';

const emptyDiscovery: ProjectDiscoveryResult = {
  groups: [],
  projects: [],
  rootItems: [],
  rootPath: ''
};

export type ProjectMainView = 'home' | 'project';

function normalizePath(path: string) {
  return path.replace(/\/+$/, '');
}

function findMatchingProject(projects: ProjectSpaceRecord[], path: string) {
  const normalizedPath = normalizePath(path);

  return [...projects]
    .sort((left, right) => right.rootPath.length - left.rootPath.length)
    .find((project) => {
      const projectPath = normalizePath(project.rootPath);

      return normalizedPath === projectPath || normalizedPath.startsWith(`${projectPath}/`);
    });
}

export function useProjectDesktop() {
  const [discovery, setDiscovery] = useState<ProjectDiscoveryResult>(emptyDiscovery);
  const [selectedExplorerTarget, setSelectedExplorerTarget] = useState<ExplorerTarget>({
    kind: 'workspace'
  });
  const [selectedLauncherAppId, setSelectedLauncherAppId] = useState('');
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [mainView, setMainView] = useState<ProjectMainView>('home');
  const [sidebarView, setSidebarView] = useState<SidebarView>('workspace');
  const [launcherApps, setLauncherApps] = useState<LauncherAppRecord[]>([]);
  const [launcherError, setLauncherError] = useState('');
  const [projectWorktrees, setProjectWorktrees] = useState<
    Record<string, ProjectWorktreeRecord[]>
  >({});
  const [hasLoaded, setHasLoaded] = useState(false);

  const groupsById = useMemo(() => {
    return Object.fromEntries(discovery.groups.map((group) => [group.id, group]));
  }, [discovery.groups]);

  const projectsById = useMemo(() => {
    return Object.fromEntries(discovery.projects.map((project) => [project.id, project]));
  }, [discovery.projects]);

  const navigationItems = useMemo<ProjectNavigationItem[]>(() => {
    return discovery.rootItems;
  }, [discovery.rootItems]);

  const project = selectedProjectId ? projectsById[selectedProjectId] : undefined;
  const activeGroup = project?.groupId ? groupsById[project.groupId] : undefined;
  const groupedProjects = useMemo(() => {
    if (!activeGroup) {
      return [];
    }

    return activeGroup.childProjectIds
      .map((projectId) => projectsById[projectId])
      .filter((entry): entry is ProjectSpaceRecord => Boolean(entry));
  }, [activeGroup, projectsById]);

  const activeNavigationItemId = project?.groupId ?? project?.id ?? '';
  const worktrees = project ? projectWorktrees[project.id] ?? [] : [];
  const selectedWorktree =
    selectedExplorerTarget.kind === 'worktree'
      ? worktrees.find((entry) => entry.id === selectedExplorerTarget.worktreeId)
      : undefined;
  const selectedLauncherApp =
    launcherApps.find((entry) => entry.id === selectedLauncherAppId) ?? launcherApps[0];
  const selectedLauncherAppLabel =
    selectedLauncherApp?.label ??
    (selectedLauncherAppId ? launcherAppLabels[selectedLauncherAppId] : undefined);

  const selectedTargetPath =
    selectedExplorerTarget.kind === 'worktree' && selectedWorktree
      ? selectedWorktree.path
      : project?.rootPath ?? '';
  const selectedTargetName =
    selectedExplorerTarget.kind === 'worktree' && selectedWorktree
      ? selectedWorktree.name
      : 'Workspace';

  function persistProjectsState(nextState: ProjectsState) {
    void projectSpaceClient.saveProjectsState(nextState).catch(() => undefined);
  }

  useEffect(() => {
    void Promise.all([
      projectSpaceClient.loadProjectsState(),
      projectSpaceClient.loadProjectDiscovery()
    ])
      .then(([state, nextDiscovery]) => {
        setDiscovery(nextDiscovery);
        setSelectedExplorerTarget(state.selectedExplorerTarget);
        setSelectedLauncherAppId(state.selectedLauncherAppId);
        setSelectedProjectId(state.selectedProjectId);
      })
      .catch(() => {
        setDiscovery(emptyDiscovery);
      })
      .finally(() => {
        setHasLoaded(true);
      });
  }, []);

  useEffect(() => {
    let canceled = false;

    void projectSpaceClient
      .loadLauncherApps()
      .then((nextLauncherApps) => {
        if (canceled) {
          return;
        }

        setLauncherApps(nextLauncherApps);
      })
      .catch(() => {
        if (!canceled) {
          setLauncherApps([]);
        }
      });

    return () => {
      canceled = true;
    };
  }, []);

  useEffect(() => {
    if (!hasLoaded) {
      return;
    }

    let nextSelectedProjectId = selectedProjectId;

    if (nextSelectedProjectId && !projectsById[nextSelectedProjectId]) {
      nextSelectedProjectId = '';
    }

    if (!nextSelectedProjectId) {
      const firstItem = navigationItems[0];

      if (firstItem?.kind === 'project') {
        nextSelectedProjectId = firstItem.projectId;
      } else if (firstItem?.kind === 'group') {
        nextSelectedProjectId = groupsById[firstItem.groupId]?.childProjectIds[0] ?? '';
      }
    }

    if (nextSelectedProjectId !== selectedProjectId) {
      setSelectedProjectId(nextSelectedProjectId);
    }
  }, [hasLoaded, navigationItems, projectsById, selectedProjectId]);

  useEffect(() => {
    if (!hasLoaded) {
      return;
    }

    if (launcherApps.length === 0) {
      if (selectedLauncherAppId) {
        setSelectedLauncherAppId('');
      }

      return;
    }

    if (!launcherApps.some((entry) => entry.id === selectedLauncherAppId)) {
      setSelectedLauncherAppId(launcherApps[0]?.id ?? '');
    }
  }, [hasLoaded, launcherApps, selectedLauncherAppId]);

  useEffect(() => {
    const appsMissingIcons = launcherApps.filter((entry) => !entry.iconDataUrl && !entry.iconUrl);

    if (appsMissingIcons.length === 0) {
      return;
    }

    let canceled = false;

    void Promise.all(
      appsMissingIcons.map(async (entry) => {
        const iconDataUrl = await projectSpaceClient
          .loadLauncherAppIcon(entry.id)
          .catch(() => undefined);

        return {
          iconDataUrl,
          id: entry.id
        };
      })
    ).then((resolvedIcons) => {
      if (canceled) {
        return;
      }

      const iconMap = new Map(
        resolvedIcons
          .filter((entry) => Boolean(entry.iconDataUrl))
          .map((entry) => [entry.id, entry.iconDataUrl])
      );

      if (iconMap.size === 0) {
        return;
      }

      setLauncherApps((current) => {
        return current.map((entry) => {
          const iconDataUrl = iconMap.get(entry.id);

          return iconDataUrl
            ? {
                ...entry,
                iconDataUrl
              }
            : entry;
        });
      });
    });

    return () => {
      canceled = true;
    };
  }, [launcherApps]);

  useEffect(() => {
    if (!project) {
      if (selectedExplorerTarget.kind !== 'workspace') {
        setSelectedExplorerTarget({ kind: 'workspace' });
      }

      return;
    }

    const cachedWorktrees = projectWorktrees[project.id];

    if (project.kind === 'standalone') {
      if (selectedExplorerTarget.kind !== 'workspace') {
        setSelectedExplorerTarget({ kind: 'workspace' });
      }

      return;
    }

    let canceled = false;

    if (
      selectedExplorerTarget.kind === 'worktree' &&
      cachedWorktrees &&
      !cachedWorktrees.some((entry) => entry.id === selectedExplorerTarget.worktreeId)
    ) {
      setSelectedExplorerTarget({ kind: 'workspace' });
    }

    void projectSpaceClient
      .loadProjectWorktrees(project.rootPath)
      .then((nextWorktrees) => {
        if (canceled) {
          return;
        }

        setProjectWorktrees((current) => ({
          ...current,
          [project.id]: nextWorktrees
        }));

        if (
          selectedExplorerTarget.kind === 'worktree' &&
          !nextWorktrees.some((entry) => entry.id === selectedExplorerTarget.worktreeId)
        ) {
          setSelectedExplorerTarget({ kind: 'workspace' });
        }
      })
      .catch(() => {
        if (!canceled) {
          setProjectWorktrees((current) => ({
            ...current,
            [project.id]: []
          }));
        }
      });

    return () => {
      canceled = true;
    };
  }, [
    project?.id,
    project?.kind,
    project?.rootPath,
    selectedExplorerTarget.kind,
    selectedExplorerTarget.kind === 'worktree' ? selectedExplorerTarget.worktreeId : ''
  ]);

  useEffect(() => {
    if (!hasLoaded) {
      return;
    }

    void projectSpaceClient
      .saveProjectsState({
        activeGroupId: project?.groupId ?? '',
        selectedExplorerTarget,
        selectedLauncherAppId,
        selectedProjectId
      })
      .catch(() => undefined);
  }, [
    hasLoaded,
    project?.groupId,
    selectedExplorerTarget,
    selectedLauncherAppId,
    selectedProjectId
  ]);

  function resolveNavigationSelection(itemId: string) {
    const item = navigationItems.find((entry) => entry.id === itemId);

    if (!item) {
      return null;
    }

    if (item.kind === 'project') {
      const project = projectsById[item.projectId];

      return {
        nextGroupId: project?.groupId ?? '',
        nextProjectId: item.projectId
      };
    }

    const group = groupsById[item.groupId];
    if (!group) {
      return null;
    }

    const currentProjectInGroup =
      selectedProjectId && group.childProjectIds.includes(selectedProjectId)
        ? selectedProjectId
        : '';

    return {
      nextGroupId: group.id,
      nextProjectId: currentProjectInGroup || group.childProjectIds[0] || ''
    };
  }

  async function createProject() {
    const selection = await projectSpaceClient.selectProjectDirectory();
    if (selection.canceled || !selection.path) {
      return;
    }

    const nextDiscovery = await projectSpaceClient.loadProjectDiscovery();
    setDiscovery(nextDiscovery);

    const matchingProject = findMatchingProject(nextDiscovery.projects, selection.path);
    if (!matchingProject) {
      setLauncherError(`Autodiscovery currently only loads projects from ${nextDiscovery.rootPath}.`);
      return;
    }

    setLauncherError('');
    setSelectedExplorerTarget({ kind: 'workspace' });
    setSelectedProjectId(matchingProject.id);
    persistProjectsState({
      activeGroupId: matchingProject.groupId ?? '',
      selectedExplorerTarget: { kind: 'workspace' },
      selectedLauncherAppId,
      selectedProjectId: matchingProject.id
    });
  }

  async function openSelectedTargetInApp() {
    if (!selectedLauncherApp || !selectedTargetPath) {
      return;
    }

    const result = await projectSpaceClient.openPathInApp({
      appId: selectedLauncherApp.id,
      path: selectedTargetPath
    });

    setLauncherError(result.status === 'error' ? result.message ?? 'Could not open path.' : '');
  }

  async function openCodexSkills() {
    const result = await projectSpaceClient.openCodexSkills();

    setLauncherError(
      result.status === 'error' ? result.message ?? 'Could not open the skills folder.' : ''
    );
  }

  async function openNewWorktreeWorkspace() {
    if (!project) {
      return;
    }

    const result = await projectSpaceClient.openPathInApp({
      appId: 'terminal',
      path: project.rootPath
    });

    setLauncherError(
      result.status === 'error'
        ? result.message ?? 'Could not open the project in Terminal.'
        : ''
    );
  }

  return {
    activeGroup,
    activeNavigationItemId,
    createProject,
    discoveryRoot: discovery.rootPath,
    groups: discovery.groups,
    groupedProjects,
    groupedProjectsLabel: activeGroup?.name,
    launcherApps,
    launcherError,
    mainView,
    navigationItems,
    openCodexSkills,
    openNewWorktreeWorkspace,
    openSelectedTargetInApp,
    project,
    projects: discovery.projects,
    resolveNavigationSelection,
    rootItems: discovery.rootItems,
    selectedExplorerTarget,
    selectedLauncherApp,
    selectedLauncherAppLabel,
    selectedProjectId,
    selectedTargetName,
    selectedTargetPath,
    selectedWorktree,
    sidebarView,
    worktrees,
    openHome() {
      setMainView('home');
    },
    selectLauncherApp(appId: string) {
      setSelectedLauncherAppId(appId);
      setLauncherError('');
      persistProjectsState({
        activeGroupId: project?.groupId ?? '',
        selectedExplorerTarget,
        selectedLauncherAppId: appId,
        selectedProjectId
      });
    },
    selectNavigationItem(itemId: string, nextWorktrees?: ProjectWorktreeRecord[], nextSelectedWorktreeId?: string) {
      const resolvedSelection = resolveNavigationSelection(itemId);

      if (!resolvedSelection) {
        return;
      }

      if (nextWorktrees && resolvedSelection.nextProjectId) {
        setProjectWorktrees((current) => ({
          ...current,
          [resolvedSelection.nextProjectId]: nextWorktrees
        }));
      }

      const nextSelectedExplorerTarget: ExplorerTarget = nextSelectedWorktreeId
        ? {
            kind: 'worktree',
            worktreeId: nextSelectedWorktreeId
          }
        : { kind: 'workspace' };

      setSelectedExplorerTarget(nextSelectedExplorerTarget);
      setSelectedProjectId(resolvedSelection.nextProjectId);
      setMainView('project');
      persistProjectsState({
        activeGroupId: resolvedSelection.nextGroupId,
        selectedExplorerTarget: nextSelectedExplorerTarget,
        selectedLauncherAppId,
        selectedProjectId: resolvedSelection.nextProjectId
      });
    },
    selectProject(projectId: string, groupId?: string) {
      const nextSelectedExplorerTarget: ExplorerTarget = { kind: 'workspace' };
      const nextProject = projectsById[projectId];

      setSelectedExplorerTarget(nextSelectedExplorerTarget);
      setSelectedProjectId(projectId);
      setMainView('project');
      setLauncherError('');
      persistProjectsState({
        activeGroupId: nextProject?.groupId ?? groupId ?? '',
        selectedExplorerTarget: nextSelectedExplorerTarget,
        selectedLauncherAppId,
        selectedProjectId: projectId
      });
    },
    selectWorkspace() {
      const nextSelectedExplorerTarget: ExplorerTarget = { kind: 'workspace' };

      setSelectedExplorerTarget(nextSelectedExplorerTarget);
      setMainView('project');
      persistProjectsState({
        activeGroupId: project?.groupId ?? '',
        selectedExplorerTarget: nextSelectedExplorerTarget,
        selectedLauncherAppId,
        selectedProjectId
      });
    },
    selectWorktree(worktreeId: string) {
      const nextSelectedExplorerTarget: ExplorerTarget = {
        kind: 'worktree',
        worktreeId
      };

      setSelectedExplorerTarget(nextSelectedExplorerTarget);
      setMainView('project');
      persistProjectsState({
        activeGroupId: project?.groupId ?? '',
        selectedExplorerTarget: nextSelectedExplorerTarget,
        selectedLauncherAppId,
        selectedProjectId
      });
    },
    setSidebarView,
    clearLauncherError() {
      setLauncherError('');
    }
  };
}
