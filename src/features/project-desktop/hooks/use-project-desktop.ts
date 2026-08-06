import { useCallback, useEffect, useMemo, useState } from 'react';
import { projectSpaceClient } from '@/api/project-space-client';
import { launcherAppLabels } from '@/shared/project-space-api';
import { parseProjectChatRoute } from '../../project-chat/project-chat-route';
import { useProjectWorktreeDiscovery } from './use-project-worktree-discovery';
import { useProjectDesktopLifecycle } from './use-project-desktop-lifecycle';
import { useCodexDesktop } from './use-codex-desktop';
import { createProjectDesktopTopologyNavigation } from './project-desktop-topology-navigation';
import { dedupeProjectCatalog } from './project-catalog-model';
import {
  connectorOverviewRefreshIntervalMs,
  createGitHubProjectRecord,
  findMatchingProject,
  githubCatalogTimeoutMs,
  initialProjectMainView,
  parseProjectRoute,
  projectMatchesGitHubRepository,
  resolveRouteProject,
  sanitizeDiscovery,
  shouldPreserveProjectRoute,
  withTimeout,
  writeRoute,
  type MachineDetailTab,
  type ProjectDetailTab,
  type ProjectMainView
} from './project-desktop-routing';
export {
  initialProjectMainView,
  machineDetailTabs,
  parseProjectRoute,
  projectDetailTabs,
  routeForView,
  writeRoute
} from './project-desktop-routing';
export type {
  MachineDetailTab,
  ParsedProjectRoute,
  ProjectDetailTab,
  ProjectMainView
} from './project-desktop-routing';
import {
  parseWorkflowRunRoute,
  normalizeRouteKey,
  routeProjectIdMatchesRepository,
  workflowRunRouteSuffix,
  shouldPreserveUnresolvedProjectRoute
} from './project-route-model';
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
import type { GitHistoryFocus } from '../components/git-focused-history';

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

function githubCatalogErrorFallback(
  message = 'Could not load the GitHub project catalog.'
): GitHubCatalogResult {
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
  const [mainView, setMainView] = useState<ProjectMainView>(() => {
    return typeof window === 'undefined'
      ? 'root'
      : initialProjectMainView(window.location.pathname);
  });
  const [projectTab, setProjectTab] = useState<ProjectDetailTab>('overview');
  const [machineTab, setMachineTab] = useState<MachineDetailTab>('overview');
  const [selectedIssueNumber, setSelectedIssueNumber] = useState<number | undefined>();
  const [selectedWorkflowRunId, setSelectedWorkflowRunId] = useState<number | undefined>();
  const [historyFocus, setHistoryFocus] = useState<GitHistoryFocus>();
  const [launcherApps, setLauncherApps] = useState<LauncherAppRecord[]>([]);
  const [launcherError, setLauncherError] = useState('');
  const [connectorOverview, setConnectorOverview] =
    useState<ConnectorOverviewResult>(connectorFallback);
  const [githubCatalog, setGitHubCatalog] = useState<GitHubCatalogResult>(githubFallback);
  const [appMeta, setAppMeta] = useState<AppMeta>(appMetaFallback);
  const [isConnectorRefreshing, setIsConnectorRefreshing] = useState(false);
  const [isGitHubRefreshing, setIsGitHubRefreshing] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const codexDesktop = useCodexDesktop({ connectorOverview, setMainView });

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
      dedupeProjectCatalog(
        [...discovery.projects, ...githubProjects],
        selectedProjectId
      ).sort((left, right) =>
        left.name.localeCompare(right.name)
      ),
    [discovery.projects, githubProjects, selectedProjectId]
  );

  const groupsById = useMemo(() => {
    return Object.fromEntries(discovery.groups.map((group) => [group.id, group]));
  }, [discovery.groups]);

  const projectsById = useMemo(() => {
    return Object.fromEntries(projects.map((project) => [project.id, project]));
  }, [projects]);

  const project = selectedProjectId
    ? (projectsById[selectedProjectId] ?? resolveRouteProject(projects, selectedProjectId))
    : undefined;
  const selectedMachine = selectedMachineId
    ? connectorOverview.machines.find((machine) => machine.id === selectedMachineId)
    : undefined;
  const activeGroup = project?.groupId ? groupsById[project.groupId] : undefined;
  const {
    discovery: worktreeDiscovery,
    refresh: refreshWorktreeDiscovery,
    worktrees
  } = useProjectWorktreeDiscovery({
    machineId: selectedMachineId,
    project,
    selectedTarget: selectedExplorerTarget,
    setSelectedTarget: setSelectedExplorerTarget
  });
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
    const projectMachine = project?.machineId
      ? connectorOverview.machines.find((machine) => machine.id === project.machineId)
      : undefined;
    const nextMachine = projectMachine ?? localMachine ?? onlineMachine ?? connectorOverview.machines[0];

    setSelectedMachineId(nextMachine.id);
  }, [
    connectorOverview.machines,
    mainView,
    project?.machineId,
    selectedMachine,
    selectedMachineId
  ]);

  const selectedTargetPath =
    selectedExplorerTarget.kind === 'worktree' && selectedWorktree
      ? selectedWorktree.path
      : (project?.rootPath ?? '');
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

  const refreshGitHubCatalog = useCallback(async (forceRefresh = false) => {
    setIsGitHubRefreshing(true);
    try {
      const catalog = await withTimeout(
        projectSpaceClient.getGitHubCatalog({ forceRefresh }),
        githubCatalogTimeoutMs,
        'The GitHub project catalog did not respond.'
      ).catch((error) =>
        githubCatalogErrorFallback(error instanceof Error ? error.message : undefined)
      );
      const normalizedCatalog = normalizeGitHubCatalog(catalog);
      setGitHubCatalog((current) =>
        normalizedCatalog.status === 'error' && current.status === 'connected'
          ? {
              ...current,
              cache: { ...current.cache, state: 'refresh-failed' },
              message: normalizedCatalog.message
            }
          : normalizedCatalog
      );
      return normalizedCatalog;
    } finally {
      setIsGitHubRefreshing(false);
    }
  }, []);

  useProjectDesktopLifecycle({
    appMetaFallback,
    emptyDiscovery,
    githubCatalog,
    hasLoaded,
    isGitHubRefreshing,
    launcherApps,
    machineTab,
    mainView,
    pinnedProjectIds,
    project,
    projects,
    projectTab,
    recentProjectIds,
    refreshConnectorOverview,
    refreshGitHubCatalog,
    selectedExplorerTarget,
    selectedIssueNumber,
    selectedLauncherAppId,
    selectedMachineId,
    selectedProjectId,
    selectedWorkflowRunId,
    setAppMeta,
    setDiscovery,
    setHasLoaded,
    setLauncherApps,
    setMachineTab,
    setMainView,
    setPinnedProjectIds,
    setProjectTab,
    setRecentProjectIds,
    setSelectedExplorerTarget,
    setSelectedIssueNumber,
    setSelectedLauncherAppId,
    setSelectedMachineId,
    setSelectedProjectId,
    setSelectedWorkflowRunId
  });
  async function createProject() {
    const selection = await projectSpaceClient.selectProjectDirectory();
    if (selection.canceled || !selection.path) {
      return;
    }

    const nextDiscovery = sanitizeDiscovery(await projectSpaceClient.loadProjectDiscovery());
    setDiscovery(nextDiscovery);

    const matchingProject = findMatchingProject(nextDiscovery.projects, selection.path);
    if (!matchingProject) {
      setLauncherError(
        `Autodiscovery currently only loads projects from ${nextDiscovery.rootPath}.`
      );
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

    const nextDiscovery = await refreshWorktreeDiscovery();

    if (!nextDiscovery) return [];

    if (nextDiscovery.state !== 'ready') {
      throw new Error(
        nextDiscovery.state === 'blocked'
          ? nextDiscovery.message
          : 'The authoritative worktree scan completed without finding a checkout.'
      );
    }

    return nextDiscovery.worktrees;
  }

  async function openSelectedTargetInApp() {
    if (!selectedLauncherApp || !selectedTargetPath) {
      return;
    }

    const result = await projectSpaceClient.openPathInApp({
      appId: selectedLauncherApp.id,
      path: selectedTargetPath
    });

    setLauncherError(result.status === 'error' ? (result.message ?? 'Could not open path.') : '');
  }

  async function openCodexSkills() {
    const result = await projectSpaceClient.openCodexSkills();

    setLauncherError(
      result.status === 'error' ? (result.message ?? 'Could not open the skills folder.') : ''
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
      result.status === 'error' ? (result.message ?? 'Could not open the project in Terminal.') : ''
    );
  }

  const topologyNavigation = createProjectDesktopTopologyNavigation({
    persistProjectsState,
    pinnedProjectIds,
    projectsById,
    projectTab,
    pushRecentProject,
    selectedLauncherAppId,
    selectedProjectId,
    setLauncherError,
    setMainView,
    setProjectTab,
    setSelectedExplorerTarget,
    setSelectedIssueNumber,
    setSelectedMachineId,
    setSelectedProjectId
  });

  return {
    ...codexDesktop,
    appMeta,
    connectorOverview,
    createProject,
    discoveryRoot: discovery.rootPath,
    githubCatalog,
    groups: discovery.groups,
    hasLoaded,
    historyFocus,
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
    selectedWorkflowRunId,
    selectedLauncherApp,
    selectedLauncherAppLabel,
    selectedMachine,
    selectedMachineId,
    selectedProjectId,
    selectedTargetName,
    selectedTargetPath,
    structureViolations: discovery.structureViolations,
    selectedWorktree,
    worktreeDiscovery,
    worktrees,
    openRoot() {
      if (selectedProjectId) {
        setMainView('project');
        setProjectTab('issues');
        setSelectedIssueNumber(undefined);
        writeRoute('project', selectedProjectId, false, 'issues');
        return;
      }

      setMainView('projects');
      writeRoute('projects');
    },
    openChat() {
      setMainView('chat');
      writeRoute('chat');
    },
    ...topologyNavigation,
    openMachines() {
      setMainView('settings');
      writeRoute('settings');
    },
    openMachine(machineId: string, tab?: MachineDetailTab) {
      const nextTab = tab ?? machineTab;

      setSelectedMachineId(machineId);
      setMachineTab(nextTab);
      setMainView('settings');
      writeRoute('settings');
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
      setSelectedWorkflowRunId(undefined);

      if (mainView === 'project' && selectedProjectId) {
        writeRoute('project', selectedProjectId, true, nextTab);
      }
    },
    openProjectHistory(focus: Omit<GitHistoryFocus, 'requestId'>) {
      setHistoryFocus({
        ...focus,
        requestId: Date.now()
      });
      setProjectTab('history');
      setSelectedIssueNumber(undefined);
      setSelectedWorkflowRunId(undefined);

      if (mainView === 'project' && selectedProjectId) {
        writeRoute('project', selectedProjectId, true, 'history');
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
    openProjectWorkflowRun(runId: number) {
      if (!selectedProjectId || !Number.isSafeInteger(runId) || runId <= 0) {
        return;
      }

      setProjectTab('deployments');
      setSelectedWorkflowRunId(runId);
      setMainView('project');
      writeRoute('project', selectedProjectId, false, 'deployments', String(runId));
    },
    closeProjectWorkflowRun() {
      setSelectedWorkflowRunId(undefined);
      if (selectedProjectId) {
        writeRoute('project', selectedProjectId, false, 'deployments');
      }
    },
    clearLauncherError() {
      setLauncherError('');
    }
  };
}
