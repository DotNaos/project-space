import { useCallback, useEffect, useMemo, useState } from 'react';
import { projectSpaceClient } from '@/api/project-space-client';
import { launcherAppLabels } from '@/shared/project-space-api';
import type {
  ConnectorOverviewResult,
  ExplorerTarget,
  GitHubCatalogRepository,
  GitHubCatalogResult,
  LauncherAppRecord,
  ProjectDiscoveryResult,
  ProjectNavigationItem,
  ProjectSpaceRecord,
  ProjectsState,
  ProjectWorktreeRecord
} from '@/shared/project-space-api';
import type { SidebarView } from '../components/sidebar-content';

const emptyDiscovery: ProjectDiscoveryResult = {
  groups: [],
  projects: [],
  rootItems: [],
  rootPath: ''
};

const connectorFallback: ConnectorOverviewResult = {
  machines: [],
  machinesRepo: {
    exists: false,
    path: ''
  },
  tailscale: {
    connected: false,
    installed: false,
    ips: [],
    peersOnline: 0,
    serveOrigins: []
  }
};

const githubFallback: GitHubCatalogResult = {
  checkedAt: '',
  repositories: [],
  status: 'auth-required'
};

export type ProjectMainView = 'root' | 'machines' | 'machine' | 'projects' | 'project';

function normalizePath(path: string) {
  return path.replace(/\/+$/, '');
}

const templatePlaceholderPattern = /\{\{.*?\}\}/;
const projectsPath = '/projects';
const machinesPath = '/machines';

function basename(path: string) {
  return path.split('/').filter(Boolean).pop() ?? path;
}

function sanitizeProjectName(project: ProjectSpaceRecord): string {
  const name = project.name?.trim();

  if (name && !templatePlaceholderPattern.test(name)) {
    return name;
  }

  return basename(project.rootPath) || 'Untitled project';
}

function sanitizeDiscovery(discovery: ProjectDiscoveryResult): ProjectDiscoveryResult {
  return {
    ...discovery,
    projects: discovery.projects.map((project) => ({
      ...project,
      name: sanitizeProjectName(project)
    }))
  };
}

function machinePath(machineId: string) {
  return `${machinesPath}/${encodeURIComponent(machineId)}`;
}

function projectPath(projectId: string) {
  return `${projectsPath}/${encodeURIComponent(projectId)}`;
}

function routeForView(view: ProjectMainView, projectId = '') {
  if (view === 'machines') {
    return machinesPath;
  }

  if (view === 'machine' && projectId) {
    return machinePath(projectId);
  }

  if (view === 'projects') {
    return projectsPath;
  }

  if (view === 'project' && projectId) {
    return projectPath(projectId);
  }

  return '/';
}

function parseProjectRoute(pathname: string) {
  if (pathname === machinesPath) {
    return { view: 'machines' as const };
  }

  if (pathname.startsWith(`${machinesPath}/`)) {
    const machineId = decodeURIComponent(pathname.slice(machinesPath.length + 1));

    return machineId ? { machineId, view: 'machine' as const } : { view: 'machines' as const };
  }

  if (pathname === projectsPath || pathname === `${projectsPath}/`) {
    return { view: 'projects' as const };
  }

  if (pathname.startsWith(`${projectsPath}/`)) {
    const projectId = decodeURIComponent(pathname.slice(projectsPath.length + 1));

    return projectId ? { projectId, view: 'project' as const } : { view: 'projects' as const };
  }

  return { view: 'root' as const };
}

function resolveRouteProject(
  projects: ProjectSpaceRecord[],
  projectId: string
): ProjectSpaceRecord | undefined {
  return projects.find((entry) => entry.id === projectId) ??
    projects.find((entry) => basename(entry.rootPath) === projectId) ??
    projects.find((entry) => entry.name === projectId);
}

function isGitHubProjectId(projectId: string) {
  return projectId.startsWith('github:');
}

function normalizeKey(value: string) {
  return value.trim().replace(/^@/, '').toLowerCase();
}

function projectMatchesGitHubRepository(
  project: ProjectSpaceRecord,
  repo: GitHubCatalogRepository
) {
  const projectName = normalizeKey(project.name);
  const projectFolder = normalizeKey(basename(project.rootPath));
  const repoFullName = normalizeKey(repo.fullName);
  const repoName = normalizeKey(repo.name);

  return (
    projectName === repoFullName ||
    projectName === repoName ||
    projectFolder === repoName ||
    projectFolder === repoFullName
  );
}

function createGitHubProjectRecord(repo: GitHubCatalogRepository): ProjectSpaceRecord {
  return {
    github: repo,
    id: `github:${repo.fullName}`,
    kind: 'github',
    name: repo.fullName,
    rootPath: ''
  };
}

function writeRoute(view: ProjectMainView, projectId = '', replace = false) {
  if (typeof window === 'undefined') {
    return;
  }

  const nextPath = routeForView(view, projectId);
  const nextUrl = `${nextPath}${window.location.search}${window.location.hash}`;

  if (window.location.pathname === nextPath) {
    return;
  }

  if (replace) {
    window.history.replaceState(null, '', nextUrl);
    return;
  }

  window.history.pushState(null, '', nextUrl);
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
  const [selectedMachineId, setSelectedMachineId] = useState('');
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [mainView, setMainView] = useState<ProjectMainView>('root');
  const [sidebarView, setSidebarView] = useState<SidebarView>('workspace');
  const [launcherApps, setLauncherApps] = useState<LauncherAppRecord[]>([]);
  const [launcherError, setLauncherError] = useState('');
  const [connectorOverview, setConnectorOverview] =
    useState<ConnectorOverviewResult>(connectorFallback);
  const [githubCatalog, setGitHubCatalog] = useState<GitHubCatalogResult>(githubFallback);
  const [isConnectorRefreshing, setIsConnectorRefreshing] = useState(false);
  const [isGitHubRefreshing, setIsGitHubRefreshing] = useState(false);
  const [projectWorktrees, setProjectWorktrees] = useState<
    Record<string, ProjectWorktreeRecord[]>
  >({});
  const [hasLoaded, setHasLoaded] = useState(false);

  const githubProjects = useMemo(() => {
    if (githubCatalog.status !== 'connected') {
      return [];
    }

    return githubCatalog.repositories
      .filter(
        (repo) =>
          !discovery.projects.some((project) => projectMatchesGitHubRepository(project, repo))
      )
      .map(createGitHubProjectRecord);
  }, [discovery.projects, githubCatalog]);

  const projects = useMemo(
    () =>
      [...discovery.projects, ...githubProjects].sort((left, right) =>
        left.name.localeCompare(right.name)
      ),
    [discovery.projects, githubProjects]
  );

  const groupsById = useMemo(() => {
    return Object.fromEntries(discovery.groups.map((group) => [group.id, group]));
  }, [discovery.groups]);

  const projectsById = useMemo(() => {
    return Object.fromEntries(projects.map((project) => [project.id, project]));
  }, [projects]);

  const navigationItems = useMemo<ProjectNavigationItem[]>(() => {
    return discovery.rootItems;
  }, [discovery.rootItems]);

  const project = selectedProjectId ? projectsById[selectedProjectId] : undefined;
  const selectedMachine = selectedMachineId
    ? connectorOverview.machines.find((machine) => machine.id === selectedMachineId)
    : undefined;
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

  const refreshConnectorOverview = useCallback(async () => {
    setIsConnectorRefreshing(true);
    try {
      const nextOverview = await projectSpaceClient.getConnectorOverview();
      const normalizedOverview = nextOverview ?? connectorFallback;
      setConnectorOverview(normalizedOverview);
      return normalizedOverview;
    } catch {
      setConnectorOverview(connectorFallback);
      return connectorFallback;
    } finally {
      setIsConnectorRefreshing(false);
    }
  }, []);

  const refreshGitHubCatalog = useCallback(async () => {
    setIsGitHubRefreshing(true);
    try {
      const catalog = await projectSpaceClient.getGitHubCatalog().catch(() => githubFallback);

      if (catalog.status === 'connected') {
        setGitHubCatalog(catalog);
        return catalog;
      }

      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const nextCatalog = await projectSpaceClient.getGitHubCatalog().catch(() => catalog);
      const normalizedCatalog = nextCatalog ?? githubFallback;
      setGitHubCatalog(normalizedCatalog);
      return normalizedCatalog;
    } finally {
      setIsGitHubRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void Promise.all([
      projectSpaceClient.loadProjectsState(),
      projectSpaceClient.loadProjectDiscovery()
    ])
      .then(([state, nextDiscovery]) => {
        const sanitizedDiscovery = sanitizeDiscovery(nextDiscovery);
        const initialRoute = parseProjectRoute(window.location.pathname);
        const routeProject =
          initialRoute.view === 'project' && initialRoute.projectId
            ? resolveRouteProject(sanitizedDiscovery.projects, initialRoute.projectId)
            : undefined;
        const shouldWaitForGitHubProject =
          initialRoute.view === 'project' &&
          initialRoute.projectId &&
          !routeProject &&
          isGitHubProjectId(initialRoute.projectId);
        const selectedProjectFromRoute =
          initialRoute.view === 'project'
            ? routeProject?.id ?? (shouldWaitForGitHubProject ? initialRoute.projectId : '')
            : state.selectedProjectId;

        setDiscovery(sanitizedDiscovery);
        setSelectedExplorerTarget(state.selectedExplorerTarget);
        setSelectedLauncherAppId(state.selectedLauncherAppId);
        setSelectedMachineId(initialRoute.view === 'machine' ? initialRoute.machineId ?? '' : '');
        setSelectedProjectId(selectedProjectFromRoute);
        setMainView(
          initialRoute.view === 'project' && !routeProject && !shouldWaitForGitHubProject
            ? 'projects'
            : initialRoute.view
        );

        if (initialRoute.view === 'project' && !shouldWaitForGitHubProject) {
          writeRoute(routeProject ? 'project' : 'projects', routeProject?.id ?? '', true);
        }
      })
      .catch(() => {
        setDiscovery(emptyDiscovery);
      })
      .finally(() => {
        setHasLoaded(true);
      });
  }, []);

  useEffect(() => {
    void refreshConnectorOverview();
  }, [refreshConnectorOverview]);

  useEffect(() => {
    void refreshGitHubCatalog();
  }, [refreshGitHubCatalog]);

  useEffect(() => {
    function handlePopState() {
      const nextRoute = parseProjectRoute(window.location.pathname);

      if (nextRoute.view === 'project') {
        const nextProject = nextRoute.projectId ? projectsById[nextRoute.projectId] : undefined;

        if (nextProject) {
          setSelectedExplorerTarget({ kind: 'workspace' });
          setSelectedProjectId(nextProject.id);
          setMainView('project');
          return;
        }

        setSelectedProjectId('');
        setMainView('projects');
        return;
      }

      if (nextRoute.view === 'machine') {
        setSelectedMachineId(nextRoute.machineId ?? '');
        setMainView('machine');
        return;
      }

      setMainView(nextRoute.view);
    }

    window.addEventListener('popstate', handlePopState);

    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, [projectsById]);

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

    if (selectedProjectId && !projectsById[selectedProjectId]) {
      setSelectedProjectId('');
      if (mainView === 'project') {
        setMainView('projects');
        writeRoute('projects', '', true);
      }
    }
  }, [hasLoaded, mainView, projectsById, selectedProjectId]);

  useEffect(() => {
    if (!hasLoaded) {
      return;
    }

    if (mainView === 'machine') {
      if (selectedMachineId) {
        writeRoute('machine', selectedMachineId, true);
      } else {
        writeRoute('machines', '', true);
      }

      return;
    }

    if (mainView === 'project') {
      if (project) {
        writeRoute('project', project.id, true);
      } else if (isGitHubProjectId(selectedProjectId)) {
        writeRoute('project', selectedProjectId, true);
      } else {
        writeRoute('projects', '', true);
      }

      return;
    }

    writeRoute(mainView, '', true);
  }, [hasLoaded, mainView, project?.id, selectedMachineId, selectedProjectId]);

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

    if (project.kind === 'standalone' || project.kind === 'github') {
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

    const nextDiscovery = sanitizeDiscovery(await projectSpaceClient.loadProjectDiscovery());
    setDiscovery(nextDiscovery);

    const matchingProject = findMatchingProject(nextDiscovery.projects, selection.path);
    if (!matchingProject) {
      setLauncherError(`Autodiscovery currently only loads projects from ${nextDiscovery.rootPath}.`);
      return;
    }

    setLauncherError('');
    setSelectedExplorerTarget({ kind: 'workspace' });
    setSelectedProjectId(matchingProject.id);
    setMainView('project');
    writeRoute('project', matchingProject.id);
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
    connectorOverview,
    createProject,
    discoveryRoot: discovery.rootPath,
    githubCatalog,
    groups: discovery.groups,
    groupedProjects,
    groupedProjectsLabel: activeGroup?.name,
    launcherApps,
    launcherError,
    isConnectorRefreshing,
    isGitHubRefreshing,
    mainView,
    navigationItems,
    openCodexSkills,
    openNewWorktreeWorkspace,
    openSelectedTargetInApp,
    project,
    projects,
    resolveNavigationSelection,
    refreshConnectorOverview,
    refreshGitHubCatalog,
    rootItems: discovery.rootItems,
    selectedExplorerTarget,
    selectedLauncherApp,
    selectedLauncherAppLabel,
    selectedMachine,
    selectedMachineId,
    selectedProjectId,
    selectedTargetName,
    selectedTargetPath,
    selectedWorktree,
    sidebarView,
    worktrees,
    openRoot() {
      setMainView('root');
      writeRoute('root');
    },
    openMachines() {
      setMainView('machines');
      writeRoute('machines');
    },
    openMachine(machineId: string) {
      setSelectedMachineId(machineId);
      setMainView('machine');
      writeRoute('machine', machineId);
    },
    openProjects() {
      setMainView('projects');
      writeRoute('projects');
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
      writeRoute('project', resolvedSelection.nextProjectId);
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
      writeRoute('project', projectId);
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
      if (selectedProjectId) {
        writeRoute('project', selectedProjectId);
      }
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
      if (selectedProjectId) {
        writeRoute('project', selectedProjectId);
      }
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
