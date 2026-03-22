import { useEffect, useMemo, useState } from 'react';
import type {
  ExplorerTarget,
  LauncherAppRecord,
  ProjectDiscoveryResult,
  ProjectGroupRecord,
  ProjectNavigationItem,
  ProjectSpaceRecord,
  ProjectWorktreeRecord
} from '@/shared/electron-api';
import type { SidebarView } from '../components/sidebar-view-tabs';

const emptyDiscovery: ProjectDiscoveryResult = {
  groups: [],
  projects: [],
  rootItems: [],
  rootPath: ''
};

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
  const [activeGroupId, setActiveGroupId] = useState('');
  const [selectedExplorerTarget, setSelectedExplorerTarget] = useState<ExplorerTarget>({
    kind: 'workspace'
  });
  const [selectedLauncherAppId, setSelectedLauncherAppId] = useState('');
  const [selectedProjectId, setSelectedProjectId] = useState('');
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

  const activeGroup = activeGroupId ? groupsById[activeGroupId] : undefined;

  const navigationItems = useMemo<ProjectNavigationItem[]>(() => {
    if (activeGroup) {
      return activeGroup.childProjectIds.reduce<ProjectNavigationItem[]>((items, projectId) => {
          const project = projectsById[projectId];
          if (!project) {
            return items;
          }

          items.push({
            id: project.id,
            kind: 'project',
            label: project.name,
            projectId: project.id
          });

          return items;
        }, []);
    }

    return discovery.rootItems;
  }, [activeGroup, discovery.rootItems, projectsById]);

  const activeNavigationItemId = useMemo(() => {
    if (activeGroup) {
      return selectedProjectId;
    }

    const selectedProject = selectedProjectId ? projectsById[selectedProjectId] : undefined;
    if (selectedProject && !selectedProject.groupId) {
      return selectedProject.id;
    }

    return '';
  }, [activeGroup, projectsById, selectedProjectId]);

  const project = selectedProjectId ? projectsById[selectedProjectId] : undefined;
  const worktrees = project ? projectWorktrees[project.id] ?? [] : [];
  const selectedWorktree =
    selectedExplorerTarget.kind === 'worktree'
      ? worktrees.find((entry) => entry.id === selectedExplorerTarget.worktreeId)
      : undefined;
  const selectedLauncherApp =
    launcherApps.find((entry) => entry.id === selectedLauncherAppId) ?? launcherApps[0];

  const selectedTargetPath =
    selectedExplorerTarget.kind === 'worktree' && selectedWorktree
      ? selectedWorktree.path
      : project?.rootPath ?? '';
  const selectedTargetName =
    selectedExplorerTarget.kind === 'worktree' && selectedWorktree
      ? selectedWorktree.name
      : 'Workspace';

  useEffect(() => {
    void Promise.all([
      window.projectSpace.loadProjectsState(),
      window.projectSpace.loadProjectDiscovery(),
      window.projectSpace.loadLauncherApps()
    ])
      .then(([state, nextDiscovery, nextLauncherApps]) => {
        setActiveGroupId(state.activeGroupId);
        setDiscovery(nextDiscovery);
        setLauncherApps(nextLauncherApps);
        setSelectedExplorerTarget(state.selectedExplorerTarget);
        setSelectedLauncherAppId(state.selectedLauncherAppId);
        setSelectedProjectId(state.selectedProjectId);
      })
      .finally(() => {
        setHasLoaded(true);
      });
  }, []);

  useEffect(() => {
    if (!hasLoaded) {
      return;
    }

    let nextActiveGroupId = activeGroupId;
    let nextSelectedProjectId = selectedProjectId;

    if (nextActiveGroupId && !groupsById[nextActiveGroupId]) {
      nextActiveGroupId = '';
    }

    if (nextActiveGroupId) {
      const childProjectIds = groupsById[nextActiveGroupId]?.childProjectIds ?? [];
      if (!childProjectIds.includes(nextSelectedProjectId)) {
        nextSelectedProjectId = childProjectIds[0] ?? '';
      }
    } else {
      const selectedProject = nextSelectedProjectId ? projectsById[nextSelectedProjectId] : undefined;
      if (selectedProject?.groupId) {
        nextSelectedProjectId = '';
      }

      if (!nextSelectedProjectId) {
        const firstRootProject = discovery.rootItems.find((item) => item.kind === 'project');
        const firstRootGroup = discovery.rootItems.find((item) => item.kind === 'group');

        if (firstRootProject?.kind === 'project') {
          nextSelectedProjectId = firstRootProject.projectId;
        } else if (firstRootGroup?.kind === 'group') {
          nextActiveGroupId = firstRootGroup.groupId;
          nextSelectedProjectId = groupsById[firstRootGroup.groupId]?.childProjectIds[0] ?? '';
        }
      }
    }

    if (nextActiveGroupId !== activeGroupId) {
      setActiveGroupId(nextActiveGroupId);
    }

    if (nextSelectedProjectId !== selectedProjectId) {
      setSelectedProjectId(nextSelectedProjectId);
    }
  }, [activeGroupId, discovery.rootItems, groupsById, hasLoaded, projectsById, selectedProjectId]);

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
        const iconDataUrl = await window.projectSpace.loadLauncherAppIcon(entry.id);

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

    void window.projectSpace.loadProjectWorktrees(project.rootPath).then((nextWorktrees) => {
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

    void window.projectSpace.saveProjectsState({
      activeGroupId,
      selectedExplorerTarget,
      selectedLauncherAppId,
      selectedProjectId
    });
  }, [
    activeGroupId,
    hasLoaded,
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
      return {
        nextGroupId: activeGroup?.id ?? '',
        nextProjectId: item.projectId
      };
    }

    const group = groupsById[item.groupId];
    if (!group) {
      return null;
    }

    return {
      nextGroupId: group.id,
      nextProjectId: group.childProjectIds[0] ?? ''
    };
  }

  async function createProject() {
    const selection = await window.projectSpace.selectProjectDirectory();
    if (selection.canceled || !selection.path) {
      return;
    }

    const nextDiscovery = await window.projectSpace.loadProjectDiscovery();
    setDiscovery(nextDiscovery);

    const matchingProject = findMatchingProject(nextDiscovery.projects, selection.path);
    if (!matchingProject) {
      setLauncherError(`Autodiscovery currently only loads projects from ${nextDiscovery.rootPath}.`);
      return;
    }

    setLauncherError('');
    setActiveGroupId(matchingProject.groupId ?? '');
    setSelectedExplorerTarget({ kind: 'workspace' });
    setSelectedProjectId(matchingProject.id);
  }

  async function openSelectedTargetInApp() {
    if (!selectedLauncherApp || !selectedTargetPath) {
      return;
    }

    const result = await window.projectSpace.openPathInApp({
      appId: selectedLauncherApp.id,
      path: selectedTargetPath
    });

    setLauncherError(result.status === 'error' ? result.message ?? 'Could not open path.' : '');
  }

  return {
    activeGroup,
    activeNavigationItemId,
    canNavigateUp: Boolean(activeGroup),
    createProject,
    discoveryRoot: discovery.rootPath,
    launcherApps,
    launcherError,
    navigationItems,
    openSelectedTargetInApp,
    project,
    projects: discovery.projects,
    resolveNavigationSelection,
    selectedExplorerTarget,
    selectedLauncherApp,
    selectedTargetName,
    selectedTargetPath,
    selectedWorktree,
    sidebarView,
    worktrees,
    navigateToRoot() {
      setActiveGroupId('');
    },
    selectLauncherApp(appId: string) {
      setSelectedLauncherAppId(appId);
      setLauncherError('');
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

      setActiveGroupId(resolvedSelection.nextGroupId);
      setSelectedExplorerTarget(
        nextSelectedWorktreeId
          ? {
              kind: 'worktree',
              worktreeId: nextSelectedWorktreeId
            }
          : { kind: 'workspace' }
      );
      setSelectedProjectId(resolvedSelection.nextProjectId);
    },
    selectWorkspace() {
      setSelectedExplorerTarget({ kind: 'workspace' });
    },
    selectWorktree(worktreeId: string) {
      setSelectedExplorerTarget({
        kind: 'worktree',
        worktreeId
      });
    },
    setSidebarView,
    clearLauncherError() {
      setLauncherError('');
    }
  };
}
