import { useCallback, useEffect, useMemo, useState } from 'react';
import { projectSpaceClient } from '@/api/project-space-client';
import { launcherAppLabels } from '@/shared/project-space-api';
import type {
  AppMeta,
  ConnectorOverviewResult,
  ExplorerTarget,
  GitHubCatalogRepository,
  GitHubCatalogResult,
  LauncherAppRecord,
  ProjectDiscoveryResult,
  ProjectSpaceRecord,
  ProjectsState,
  ProjectWorktreeRecord
} from '@/shared/project-space-api';

const emptyDiscovery: ProjectDiscoveryResult = {
  groups: [],
  projects: [],
  rootItems: [],
  rootPath: '',
  structureViolations: []
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

function githubCatalogErrorFallback(message = 'Could not load the GitHub project catalog.') {
  return {
    checkedAt: new Date().toISOString(),
    message,
    repositories: [],
    status: 'error'
  } satisfies GitHubCatalogResult;
}

function normalizeGitHubCatalog(catalog: GitHubCatalogResult | undefined) {
  if (!catalog) {
    return githubCatalogErrorFallback();
  }

  return {
    ...catalog,
    checkedAt: catalog.checkedAt || new Date().toISOString()
  };
}

const appMetaFallback: AppMeta = {
  name: 'project-space',
  platform: 'unknown',
  version: 'unknown'
};

export type ProjectMainView =
  | 'root'
  | 'machines'
  | 'machine'
  | 'projects'
  | 'project'
  | 'settings';

export const projectDetailTabs = [
  'overview',
  'issues',
  'machines',
  'workspaces',
  'history',
  'template',
  'deployments',
  'codex'
] as const;
export type ProjectDetailTab = (typeof projectDetailTabs)[number];

export const machineDetailTabs = ['overview', 'projects', 'terminal'] as const;
export type MachineDetailTab = (typeof machineDetailTabs)[number];

function parseProjectDetailTab(segment: string | undefined): ProjectDetailTab {
  return projectDetailTabs.includes(segment as ProjectDetailTab)
    ? (segment as ProjectDetailTab)
    : 'overview';
}

function parseMachineDetailTab(segment: string | undefined): MachineDetailTab {
  return machineDetailTabs.includes(segment as MachineDetailTab)
    ? (segment as MachineDetailTab)
    : 'overview';
}

function normalizePath(path: string) {
  return path.replace(/\/+$/, '');
}

const templatePlaceholderPattern = /\{\{.*?\}\}/;
const projectsPath = '/projects';
const machinesPath = '/machines';
const connectorOverviewRefreshIntervalMs = 60_000;
const githubCatalogTimeoutMs = 12_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);

    promise.then(
      (value) => {
        window.clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

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
    })),
    structureViolations: discovery.structureViolations ?? []
  };
}

function machinePath(machineId: string) {
  return `${machinesPath}/${encodeURIComponent(machineId)}`;
}

function projectPath(projectId: string) {
  return `${projectsPath}/${encodeURIComponent(projectId)}`;
}

const settingsPath = '/settings';

function routeForView(view: ProjectMainView, projectId = '', tab = '', detail = '') {
  if (view === 'machines') {
    return machinesPath;
  }

  if (view === 'machine' && projectId) {
    const base = machinePath(projectId);

    return tab && tab !== 'overview' ? `${base}/${tab}` : base;
  }

  if (view === 'projects') {
    return projectsPath;
  }

  if (view === 'project' && projectId) {
    const base = projectPath(projectId);

    if (tab === 'issues' && detail) {
      return `${base}/issues/${encodeURIComponent(detail)}`;
    }

    if (!tab || tab === 'overview') {
      return base;
    }

    return `${base}/${tab}`;
  }

  if (view === 'settings') {
    return settingsPath;
  }

  return '/';
}

interface ParsedProjectRoute {
  issueNumber?: number;
  machineId?: string;
  machineTab?: MachineDetailTab;
  projectId?: string;
  projectTab?: ProjectDetailTab;
  view: ProjectMainView;
}

function parseProjectRoute(pathname: string): ParsedProjectRoute {
  if (pathname === settingsPath || pathname === `${settingsPath}/`) {
    return { view: 'settings' };
  }

  if (pathname === machinesPath) {
    return { view: 'machines' };
  }

  if (pathname.startsWith(`${machinesPath}/`)) {
    const rest = pathname.slice(machinesPath.length + 1);
    const [rawMachineId, rawTab] = rest.split('/');
    const machineId = decodeURIComponent(rawMachineId ?? '');

    return machineId
      ? { machineId, machineTab: parseMachineDetailTab(rawTab), view: 'machine' }
      : { view: 'machines' };
  }

  if (pathname === projectsPath || pathname === `${projectsPath}/`) {
    return { view: 'projects' };
  }

  if (pathname.startsWith(`${projectsPath}/`)) {
    const rest = pathname.slice(projectsPath.length + 1);
    const [rawProjectId, rawTab, rawDetail] = rest.split('/');
    const projectId = decodeURIComponent(rawProjectId ?? '');
    const issueNumber = rawTab === 'issues' && rawDetail ? Number(rawDetail) : undefined;

    return projectId
      ? {
          issueNumber: Number.isFinite(issueNumber) ? issueNumber : undefined,
          projectId,
          projectTab: parseProjectDetailTab(rawTab),
          view: 'project'
        }
      : { view: 'projects' };
  }

  return { view: 'root' };
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

function writeRoute(view: ProjectMainView, projectId = '', replace = false, tab = '', detail = '') {
  if (typeof window === 'undefined') {
    return;
  }

  const nextPath = routeForView(view, projectId, tab, detail);
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
  const [pinnedProjectIds, setPinnedProjectIds] = useState<string[]>([]);
  const [recentProjectIds, setRecentProjectIds] = useState<string[]>([]);
  const [mainView, setMainView] = useState<ProjectMainView>('root');
  const [projectTab, setProjectTab] = useState<ProjectDetailTab>('overview');
  const [machineTab, setMachineTab] = useState<MachineDetailTab>('overview');
  const [selectedIssueNumber, setSelectedIssueNumber] = useState<number | undefined>();
  const [launcherApps, setLauncherApps] = useState<LauncherAppRecord[]>([]);
  const [launcherError, setLauncherError] = useState('');
  const [connectorOverview, setConnectorOverview] =
    useState<ConnectorOverviewResult>(connectorFallback);
  const [githubCatalog, setGitHubCatalog] = useState<GitHubCatalogResult>(githubFallback);
  const [appMeta, setAppMeta] = useState<AppMeta>(appMetaFallback);
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

  const project = selectedProjectId ? projectsById[selectedProjectId] : undefined;
  const selectedMachine = selectedMachineId
    ? connectorOverview.machines.find((machine) => machine.id === selectedMachineId)
    : undefined;
  const activeGroup = project?.groupId ? groupsById[project.groupId] : undefined;
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

  useEffect(() => {
    if (mainView !== 'project' || connectorOverview.machines.length === 0) {
      return;
    }

    if (selectedMachine) {
      return;
    }

    const localMachine = connectorOverview.machines.find(
      (machine) => machine.connector.status === 'local'
    );
    const onlineMachine = connectorOverview.machines.find(
      (machine) => machine.connector.status === 'online'
    );
    const nextMachine = localMachine ?? onlineMachine ?? connectorOverview.machines[0];

    setSelectedMachineId(nextMachine.id);
  }, [connectorOverview.machines, mainView, selectedMachine]);

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

  function pushRecentProject(projectId: string) {
    const nextRecentProjectIds = [
      projectId,
      ...recentProjectIds.filter((entry) => entry !== projectId)
    ].slice(0, 8);
    setRecentProjectIds(nextRecentProjectIds);

    return nextRecentProjectIds;
  }

  useEffect(() => {
    if (!hasLoaded || mainView !== 'project' || !project) {
      return;
    }

    setRecentProjectIds((current) => {
      if (current[0] === project.id) {
        return current;
      }

      const nextRecentProjectIds = [
        project.id,
        ...current.filter((entry) => entry !== project.id)
      ].slice(0, 8);

      persistProjectsState({
        activeGroupId: project.groupId ?? '',
        pinnedProjectIds,
        recentProjectIds: nextRecentProjectIds,
        selectedExplorerTarget,
        selectedLauncherAppId,
        selectedProjectId: project.id
      });

      return nextRecentProjectIds;
    });
  }, [hasLoaded, mainView, project?.id]);

  const refreshConnectorOverview = useCallback(async ({ silent = false } = {}) => {
    if (!silent) {
      setIsConnectorRefreshing(true);
    }

    try {
      const nextOverview = await projectSpaceClient.getConnectorOverview();
      const normalizedOverview = nextOverview ?? connectorFallback;
      setConnectorOverview(normalizedOverview);
      return normalizedOverview;
    } catch {
      setConnectorOverview(connectorFallback);
      return connectorFallback;
    } finally {
      if (!silent) {
        setIsConnectorRefreshing(false);
      }
    }
  }, []);

  const refreshGitHubCatalog = useCallback(async () => {
    setIsGitHubRefreshing(true);
    try {
      const catalog = await withTimeout(
        projectSpaceClient.getGitHubCatalog(),
        githubCatalogTimeoutMs,
        'The GitHub project catalog did not respond.'
      )
        .catch(() => githubCatalogErrorFallback());

      if (catalog.status === 'connected') {
        const normalizedCatalog = normalizeGitHubCatalog(catalog);
        setGitHubCatalog(normalizedCatalog);
        return normalizedCatalog;
      }

      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const nextCatalog = await withTimeout(
        projectSpaceClient.getGitHubCatalog(),
        githubCatalogTimeoutMs,
        'The GitHub project catalog did not respond.'
      ).catch(() => catalog);
      const normalizedCatalog = normalizeGitHubCatalog(nextCatalog);
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
            ? routeProject?.id ?? (shouldWaitForGitHubProject ? initialRoute.projectId ?? '' : '')
            : state.selectedProjectId;

        setDiscovery(sanitizedDiscovery);
        setPinnedProjectIds(state.pinnedProjectIds ?? []);
        setRecentProjectIds(state.recentProjectIds ?? []);
        setSelectedExplorerTarget(state.selectedExplorerTarget);
        setSelectedLauncherAppId(state.selectedLauncherAppId);
        setSelectedMachineId(initialRoute.view === 'machine' ? initialRoute.machineId ?? '' : '');
        setSelectedProjectId(selectedProjectFromRoute);
        setSelectedIssueNumber(initialRoute.issueNumber);
        setProjectTab(initialRoute.projectTab ?? 'overview');
        setMachineTab(initialRoute.machineTab ?? 'overview');
        setMainView(
          initialRoute.view === 'project' && !routeProject && !shouldWaitForGitHubProject
            ? 'projects'
            : initialRoute.view
        );

        if (initialRoute.view === 'project' && !shouldWaitForGitHubProject) {
          writeRoute(
            routeProject ? 'project' : 'projects',
            routeProject?.id ?? '',
            true,
            initialRoute.projectTab ?? 'overview',
            initialRoute.projectTab === 'issues' ? String(initialRoute.issueNumber ?? '') : ''
          );
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
    let isRefreshing = false;
    const interval = window.setInterval(() => {
      if (isRefreshing) {
        return;
      }

      isRefreshing = true;
      void refreshConnectorOverview({ silent: true }).finally(() => {
        isRefreshing = false;
      });
    }, connectorOverviewRefreshIntervalMs);

    return () => {
      window.clearInterval(interval);
    };
  }, [refreshConnectorOverview]);

  useEffect(() => {
    void refreshGitHubCatalog();
  }, [refreshGitHubCatalog]);

  useEffect(() => {
    let canceled = false;

    void projectSpaceClient
      .getAppMeta()
      .then((nextMeta) => {
        if (!canceled) {
          setAppMeta(nextMeta ?? appMetaFallback);
        }
      })
      .catch(() => {
        if (!canceled) {
          setAppMeta(appMetaFallback);
        }
      });

    return () => {
      canceled = true;
    };
  }, []);

  useEffect(() => {
    function handlePopState() {
      const nextRoute = parseProjectRoute(window.location.pathname);

      if (nextRoute.view === 'project') {
        const nextProject = nextRoute.projectId ? projectsById[nextRoute.projectId] : undefined;

        if (nextProject) {
          setSelectedExplorerTarget({ kind: 'workspace' });
          setSelectedProjectId(nextProject.id);
          setSelectedIssueNumber(nextRoute.issueNumber);
          setProjectTab(nextRoute.projectTab ?? 'overview');
          setMainView('project');
          return;
        }

        setSelectedProjectId('');
        setMainView('projects');
        return;
      }

      if (nextRoute.view === 'machine') {
        setSelectedMachineId(nextRoute.machineId ?? '');
        setMachineTab(nextRoute.machineTab ?? 'overview');
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
        writeRoute('machine', selectedMachineId, true, machineTab);
      } else {
        writeRoute('machines', '', true);
      }

      return;
    }

    if (mainView === 'project') {
      if (project) {
        writeRoute(
          'project',
          project.id,
          true,
          projectTab,
          projectTab === 'issues' ? String(selectedIssueNumber ?? '') : ''
        );
      } else if (isGitHubProjectId(selectedProjectId)) {
        writeRoute(
          'project',
          selectedProjectId,
          true,
          projectTab,
          projectTab === 'issues' ? String(selectedIssueNumber ?? '') : ''
        );
      } else {
        writeRoute('projects', '', true);
      }

      return;
    }

    writeRoute(mainView, '', true);
  }, [
    hasLoaded,
    machineTab,
    mainView,
    project?.id,
    projectTab,
    selectedIssueNumber,
    selectedMachineId,
    selectedProjectId
  ]);

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
        pinnedProjectIds,
        recentProjectIds,
        selectedExplorerTarget,
        selectedLauncherAppId,
        selectedProjectId
      })
      .catch(() => undefined);
  }, [
    hasLoaded,
    pinnedProjectIds,
    project?.groupId,
    recentProjectIds,
    selectedExplorerTarget,
    selectedLauncherAppId,
    selectedProjectId
  ]);

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
    const nextRecentProjectIds = pushRecentProject(matchingProject.id);
    persistProjectsState({
      activeGroupId: matchingProject.groupId ?? '',
      pinnedProjectIds,
      recentProjectIds: nextRecentProjectIds,
      selectedExplorerTarget: { kind: 'workspace' },
      selectedLauncherAppId,
      selectedProjectId: matchingProject.id
    });
  }

  async function refreshProjectDiscovery() {
    const nextDiscovery = sanitizeDiscovery(await projectSpaceClient.loadProjectDiscovery());
    setDiscovery(nextDiscovery);
    return nextDiscovery;
  }

  async function refreshProjectWorktrees() {
    if (!project) {
      return [];
    }

    const nextWorktrees = await projectSpaceClient.loadProjectWorktrees(project.rootPath);

    setProjectWorktrees((current) => ({
      ...current,
      [project.id]: nextWorktrees
    }));

    return nextWorktrees;
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
    appMeta,
    connectorOverview,
    createProject,
    discoveryRoot: discovery.rootPath,
    githubCatalog,
    groups: discovery.groups,
    launcherApps,
    launcherError,
    isConnectorRefreshing,
    isGitHubRefreshing,
    machineTab,
    mainView,
    openCodexSkills,
    openNewWorktreeWorkspace,
    openSelectedTargetInApp,
    pinnedProjectIds,
    recentProjectIds,
    project,
    projects,
    projectTab,
    refreshProjectDiscovery,
    refreshProjectWorktrees,
    refreshConnectorOverview,
    refreshGitHubCatalog,
    selectedExplorerTarget,
    selectedIssueNumber,
    selectedLauncherApp,
    selectedLauncherAppLabel,
    selectedMachine,
    selectedMachineId,
    selectedProjectId,
    selectedTargetName,
    selectedTargetPath,
    structureViolations: discovery.structureViolations,
    selectedWorktree,
    worktrees,
    openRoot() {
      setMainView('root');
      writeRoute('root');
    },
    openMachines() {
      setMainView('machines');
      writeRoute('machines');
    },
    openMachine(machineId: string, tab?: MachineDetailTab) {
      const nextTab = tab ?? machineTab;

      setSelectedMachineId(machineId);
      setMachineTab(nextTab);
      setMainView('machine');
      writeRoute('machine', machineId, false, nextTab);
    },
    selectMachineContext(machineId: string) {
      setSelectedMachineId(machineId);
    },
    openProjects() {
      setMainView('projects');
      writeRoute('projects');
    },
    openSettings() {
      setMainView('settings');
      writeRoute('settings');
    },
    selectProjectTab(nextTab: ProjectDetailTab) {
      setProjectTab(nextTab);
      setSelectedIssueNumber(undefined);

      if (mainView === 'project' && selectedProjectId) {
        writeRoute('project', selectedProjectId, true, nextTab);
      }
    },
    selectMachineTab(nextTab: MachineDetailTab) {
      setMachineTab(nextTab);

      if (mainView === 'machine' && selectedMachineId) {
        writeRoute('machine', selectedMachineId, true, nextTab);
      }
    },
    selectLauncherApp(appId: string) {
      setSelectedLauncherAppId(appId);
      setLauncherError('');
      persistProjectsState({
        activeGroupId: project?.groupId ?? '',
        pinnedProjectIds,
        recentProjectIds,
        selectedExplorerTarget,
        selectedLauncherAppId: appId,
        selectedProjectId
      });
    },
    togglePinnedProject(projectId: string) {
      setPinnedProjectIds((current) => {
        const nextPinnedProjectIds = current.includes(projectId)
          ? current.filter((entry) => entry !== projectId)
          : [...current, projectId];

        persistProjectsState({
          activeGroupId: project?.groupId ?? '',
          pinnedProjectIds: nextPinnedProjectIds,
          recentProjectIds,
          selectedExplorerTarget,
          selectedLauncherAppId,
          selectedProjectId
        });

        return nextPinnedProjectIds;
      });
    },
    selectProject(projectId: string, groupId?: string) {
      const nextSelectedExplorerTarget: ExplorerTarget = { kind: 'workspace' };
      const nextProject = projectsById[projectId];

      setSelectedExplorerTarget(nextSelectedExplorerTarget);
      setSelectedProjectId(projectId);
      setSelectedIssueNumber(undefined);
      setMainView('project');
      writeRoute(
        'project',
        projectId,
        false,
        projectTab
      );
      setLauncherError('');
      const nextRecentProjectIds = pushRecentProject(projectId);
      persistProjectsState({
        activeGroupId: nextProject?.groupId ?? groupId ?? '',
        pinnedProjectIds,
        recentProjectIds: nextRecentProjectIds,
        selectedExplorerTarget: nextSelectedExplorerTarget,
        selectedLauncherAppId,
        selectedProjectId: projectId
      });
    },
    selectWorkspace() {
      const nextSelectedExplorerTarget: ExplorerTarget = { kind: 'workspace' };

      setSelectedExplorerTarget(nextSelectedExplorerTarget);
      setSelectedIssueNumber(undefined);
      setMainView('project');
      if (selectedProjectId) {
        writeRoute('project', selectedProjectId, true, projectTab);
      }
      persistProjectsState({
        activeGroupId: project?.groupId ?? '',
        pinnedProjectIds,
        recentProjectIds,
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
      setSelectedIssueNumber(undefined);
      setMainView('project');
      if (selectedProjectId) {
        writeRoute('project', selectedProjectId, true, projectTab);
      }
      persistProjectsState({
        activeGroupId: project?.groupId ?? '',
        pinnedProjectIds,
        recentProjectIds,
        selectedExplorerTarget: nextSelectedExplorerTarget,
        selectedLauncherAppId,
        selectedProjectId
      });
    },
    openProjectIssue(issueNumber: number) {
      if (!selectedProjectId) {
        return;
      }

      setProjectTab('issues');
      setSelectedIssueNumber(issueNumber);
      setMainView('project');
      writeRoute('project', selectedProjectId, false, 'issues', String(issueNumber));
    },
    clearLauncherError() {
      setLauncherError('');
    }
  };
}
