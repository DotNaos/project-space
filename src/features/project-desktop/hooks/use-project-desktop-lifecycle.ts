import { useEffect, type Dispatch, type SetStateAction } from 'react';
import { projectSpaceClient } from '@/api/project-space-client';
import type {
  AppMeta,
  ExplorerTarget,
  GitHubCatalogResult,
  LauncherAppRecord,
  ProjectDiscoveryResult,
  ProjectSpaceRecord
} from '@/shared/project-space-api';
import { parseProjectChatRoute } from '../../project-chat/project-chat-route';
import { parseCodexSessionRoute } from '../../codex-sessions/codex-session-route';
import { shouldPreserveUnresolvedProjectRoute } from './project-route-model';
import {
  connectorOverviewRefreshIntervalMs,
  parseProjectNavigationRoute,
  parseProjectRoute,
  replaceLegacyMachinesRoute,
  resolveDefaultProjectId,
  resolveRouteProject,
  sanitizeDiscovery,
  shouldLoadGitHubCatalog,
  shouldPreserveProjectRoute,
  writeRoute,
  type MachineDetailTab,
  type ProjectDetailTab,
  type ProjectMainView
} from './project-desktop-routing';

type Setter<T> = Dispatch<SetStateAction<T>>;

interface LifecycleOptions {
  appMetaFallback: AppMeta;
  emptyDiscovery: ProjectDiscoveryResult;
  githubCatalog: GitHubCatalogResult;
  hasLoaded: boolean;
  isGitHubRefreshing: boolean;
  launcherApps: LauncherAppRecord[];
  machineTab: MachineDetailTab;
  mainView: ProjectMainView;
  pinnedProjectIds: string[];
  project?: ProjectSpaceRecord;
  projects: ProjectSpaceRecord[];
  projectTab: ProjectDetailTab;
  recentProjectIds: string[];
  refreshConnectorOverview(options?: { silent?: boolean }): Promise<unknown>;
  refreshGitHubCatalog(forceRefresh?: boolean): Promise<GitHubCatalogResult>;
  selectedExplorerTarget: ExplorerTarget;
  selectedIssueNumber?: number;
  selectedLauncherAppId: string;
  selectedMachineId: string;
  selectedProjectId: string;
  selectedWorkflowRunId?: number;
  setAppMeta: Setter<AppMeta>;
  setDiscovery: Setter<ProjectDiscoveryResult>;
  setHasLoaded: Setter<boolean>;
  setLauncherApps: Setter<LauncherAppRecord[]>;
  setMachineTab: Setter<MachineDetailTab>;
  setMainView: Setter<ProjectMainView>;
  setPinnedProjectIds: Setter<string[]>;
  setProjectTab: Setter<ProjectDetailTab>;
  setRecentProjectIds: Setter<string[]>;
  setSelectedExplorerTarget: Setter<ExplorerTarget>;
  setSelectedIssueNumber: Setter<number | undefined>;
  setSelectedLauncherAppId: Setter<string>;
  setSelectedMachineId: Setter<string>;
  setSelectedProjectId: Setter<string>;
  setSelectedWorkflowRunId: Setter<number | undefined>;
}

export function useProjectDesktopLifecycle(options: LifecycleOptions) {
  const {
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
  } = options;

    useEffect(() => {
      if (!hasLoaded || !shouldLoadGitHubCatalog(mainView) || githubCatalog.checkedAt || isGitHubRefreshing)
        return;
      void refreshGitHubCatalog();
    }, [githubCatalog.checkedAt, hasLoaded, isGitHubRefreshing, mainView, refreshGitHubCatalog]);

    useEffect(() => {
      if (!hasLoaded || mainView !== 'projects') {
        return;
      }

      const defaultProjectId = resolveDefaultProjectId({
        pinnedProjectIds,
        projects,
        recentProjectIds,
        selectedProjectId
      });

      if (!defaultProjectId || !resolveRouteProject(projects, defaultProjectId)) {
        return;
      }

      const nextProject = resolveRouteProject(projects, defaultProjectId);
      setSelectedProjectId(defaultProjectId);
      setSelectedMachineId(nextProject?.machineId ?? '');
      setSelectedIssueNumber(undefined);
      setSelectedWorkflowRunId(undefined);
      setProjectTab('issues');
      setMainView('project');
      writeRoute('project', defaultProjectId, true, 'issues');
    }, [
      hasLoaded,
      mainView,
      pinnedProjectIds,
      projects,
      recentProjectIds,
      selectedProjectId
    ]);

    useEffect(() => {
      if (githubCatalog.cache?.state !== 'refreshing') return;
      let canceled = false;
      let timer = 0;
      let attempts = 0;
      const poll = () => {
        timer = window.setTimeout(
          async () => {
            const next = await refreshGitHubCatalog();
            attempts += 1;
            if (!canceled && next.cache?.state === 'refreshing' && attempts < 8) poll();
          },
          Math.min(1_500 * (attempts + 1), 5_000)
        );
      };
      poll();
      return () => {
        canceled = true;
        window.clearTimeout(timer);
      };
    }, [githubCatalog.cache?.state, refreshGitHubCatalog]);

    useEffect(() => {
      const initialRoute = parseProjectRoute(window.location.pathname);
      replaceLegacyMachinesRoute(window.location.pathname);
      void Promise.all([
        projectSpaceClient.loadProjectsState(),
        projectSpaceClient.loadProjectDiscovery(),
        projectSpaceClient.getAppMeta()
      ])
        .then(([state, nextDiscovery, nextMeta]) => {
          if (!nextMeta?.runtime) {
            throw new Error('Runtime binding evidence is unavailable.');
          }
          setAppMeta(nextMeta);
          const sanitizedDiscovery = sanitizeDiscovery(nextDiscovery);
          const isDefaultEntry = initialRoute.view === 'root' || initialRoute.view === 'projects';
          const routeProject =
            initialRoute.view === 'project' && initialRoute.projectId
              ? resolveRouteProject(sanitizedDiscovery.projects, initialRoute.projectId)
              : undefined;
          const shouldWaitForGitHubProject =
            initialRoute.view === 'project' &&
            shouldPreserveProjectRoute(initialRoute.projectId, routeProject);
          const selectedProjectFromRoute = initialRoute.view === 'project'
            ? (routeProject?.id ??
              (shouldWaitForGitHubProject ? (initialRoute.projectId ?? '') : ''))
            : isDefaultEntry
              ? resolveDefaultProjectId({
                  pinnedProjectIds: state.pinnedProjectIds,
                  projects: sanitizedDiscovery.projects,
                  recentProjectIds: state.recentProjectIds,
                  selectedProjectId: state.selectedProjectId
                })
              : state.selectedProjectId;
          const selectedProjectRecord = selectedProjectFromRoute
            ? resolveRouteProject(sanitizedDiscovery.projects, selectedProjectFromRoute)
            : undefined;
          const initialMainView = isDefaultEntry
            ? selectedProjectFromRoute
              ? 'project'
              : 'projects'
            : initialRoute.view;
          const initialProjectTab = isDefaultEntry
            ? 'issues'
            : (initialRoute.projectTab ?? 'overview');
  
          setDiscovery(sanitizedDiscovery);
          setPinnedProjectIds(state.pinnedProjectIds ?? []);
          setRecentProjectIds(state.recentProjectIds ?? []);
          setSelectedExplorerTarget(state.selectedExplorerTarget);
          setSelectedLauncherAppId(state.selectedLauncherAppId);
          setSelectedMachineId(
            initialRoute.view === 'machine'
              ? (initialRoute.machineId ?? '')
              : (selectedProjectRecord?.machineId ?? '')
          );
          setSelectedProjectId(selectedProjectFromRoute);
          setSelectedIssueNumber(initialRoute.issueNumber);
          setSelectedWorkflowRunId(initialRoute.workflowRunId);
          setProjectTab(initialProjectTab);
          setMachineTab(initialRoute.machineTab ?? 'overview');
          setMainView(initialMainView);

          if (isDefaultEntry && selectedProjectFromRoute) {
            writeRoute('project', selectedProjectFromRoute, true, 'issues');
          } else if (initialRoute.view === 'project' && routeProject) {
            writeRoute(
              'project',
              routeProject.id,
              true,
              initialRoute.projectTab ?? 'overview',
              initialRoute.projectTab === 'issues'
                ? initialRoute.createIssue
                  ? 'new'
                  : String(initialRoute.issueNumber ?? '')
                : initialRoute.projectTab === 'deployments'
                  ? String(initialRoute.workflowRunId ?? '')
                  : ''
            );
          }
        })
        .catch(() => {
          setAppMeta(appMetaFallback);
          setDiscovery(emptyDiscovery);
          setSelectedProjectId('');
          setMainView('projects');
          writeRoute('projects', '', true);
        })
        .finally(() => {
          setHasLoaded(true);
        });
    }, []);

    useEffect(() => {
      if (mainView === 'machines' || mainView === 'settings') {
        return;
      }
      void refreshConnectorOverview();
    }, [mainView, refreshConnectorOverview]);
  
    useEffect(() => {
      if (mainView === 'machines' || mainView === 'settings') {
        return;
      }
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
    }, [mainView, refreshConnectorOverview]);
  
    useEffect(() => {
      function handlePopState() {
        const nextRoute = parseProjectNavigationRoute(window.location.pathname);

        if (nextRoute.view === 'root' || nextRoute.view === 'projects') {
          const defaultProjectId = resolveDefaultProjectId({
            pinnedProjectIds,
            projects,
            recentProjectIds,
            selectedProjectId
          });

          if (defaultProjectId) {
            const nextProject = resolveRouteProject(projects, defaultProjectId);
            setSelectedProjectId(defaultProjectId);
            setSelectedMachineId(nextProject?.machineId ?? '');
            setSelectedIssueNumber(undefined);
            setSelectedWorkflowRunId(undefined);
            setProjectTab('issues');
            setMainView('project');
            writeRoute('project', defaultProjectId, true, 'issues');
            return;
          }

          setSelectedProjectId('');
          setMainView('projects');
          writeRoute('projects', '', true);
          return;
        }
  
        if (nextRoute.view === 'project') {
          const nextProject = nextRoute.projectId
            ? resolveRouteProject(projects, nextRoute.projectId)
            : undefined;
  
          if (nextProject) {
            setSelectedExplorerTarget({ kind: 'workspace' });
            setSelectedProjectId(nextRoute.projectId ?? nextProject.id);
            setSelectedMachineId(nextProject.machineId ?? '');
            setSelectedIssueNumber(nextRoute.issueNumber);
            setSelectedWorkflowRunId(nextRoute.workflowRunId);
            setProjectTab(nextRoute.projectTab ?? 'overview');
            setMainView('project');
            return;
          }
  
          if (nextRoute.projectId) {
            setSelectedProjectId(nextRoute.projectId);
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
    }, [pinnedProjectIds, projects, recentProjectIds, selectedProjectId]);
  
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
  
      if (mainView === 'project' && selectedProjectId && !project) {
        if (!githubCatalog.checkedAt && !isGitHubRefreshing) {
          void refreshGitHubCatalog();
        }
  
        return;
      }
  
      if (selectedProjectId && !project) {
        setSelectedProjectId('');
        if (mainView === 'project') {
          setMainView('projects');
          writeRoute('projects', '', true);
        }
      }
    }, [
      githubCatalog.checkedAt,
      hasLoaded,
      isGitHubRefreshing,
      mainView,
      project,
      refreshGitHubCatalog,
      selectedProjectId
    ]);
  
    useEffect(() => {
      if (!hasLoaded) {
        return;
      }
  
      if (
        mainView === 'chat' &&
        typeof window !== 'undefined' &&
        parseProjectChatRoute(window.location.pathname).matches
      ) {
        return;
      }

      if (
        mainView === 'codex' &&
        typeof window !== 'undefined' &&
        parseCodexSessionRoute(window.location.pathname).matches
      ) {
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
          const routeProjectId =
            selectedProjectId && resolveRouteProject([project], selectedProjectId)
              ? selectedProjectId
              : project.id;
  
          const currentRoute = parseProjectRoute(window.location.pathname);
          const issueRouteDetail =
            projectTab === 'issues' && currentRoute.createIssue
              ? 'new'
              : String(selectedIssueNumber ?? '');

          writeRoute(
            'project',
            routeProjectId,
            true,
            projectTab,
            projectTab === 'issues'
              ? issueRouteDetail
              : projectTab === 'deployments'
                ? String(selectedWorkflowRunId ?? '')
                : ''
          );
        } else if (
          shouldPreserveUnresolvedProjectRoute({
            githubCatalogCheckedAt: githubCatalog.checkedAt,
            isGitHubRefreshing,
            projectId: selectedProjectId,
            routeProjectResolved: Boolean(project)
          })
        ) {
          const currentRoute = parseProjectRoute(window.location.pathname);
          const issueRouteDetail =
            projectTab === 'issues' && currentRoute.createIssue
              ? 'new'
              : String(selectedIssueNumber ?? '');

          writeRoute(
            'project',
            selectedProjectId,
            true,
            projectTab,
            projectTab === 'issues'
              ? issueRouteDetail
              : projectTab === 'deployments'
                ? String(selectedWorkflowRunId ?? '')
                : ''
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
      selectedWorkflowRunId,
      selectedMachineId,
      selectedProjectId,
      githubCatalog.checkedAt,
      isGitHubRefreshing
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
  
}
