import type {
  ExplorerTarget,
  ProjectSpaceRecord,
  ProjectsState
} from '@/shared/project-space-api';
import {
  resolveRouteProject,
  writeRoute,
  type ProjectDetailTab,
  type ProjectMainView
} from './project-desktop-routing';

interface ProjectDesktopTopologyNavigationOptions {
  persistProjectsState: (state: ProjectsState) => void;
  pinnedProjectIds: string[];
  projectsById: Readonly<Record<string, ProjectSpaceRecord>>;
  projectTab: ProjectDetailTab;
  pushRecentProject: (projectId: string) => string[];
  selectedLauncherAppId: string;
  selectedProjectId: string;
  setLauncherError: (message: string) => void;
  setMainView: (view: ProjectMainView) => void;
  setProjectTab: (tab: ProjectDetailTab) => void;
  setSelectedExplorerTarget: (target: ExplorerTarget) => void;
  setSelectedIssueNumber: (issueNumber: number | undefined) => void;
  setSelectedMachineId: (machineId: string) => void;
  setSelectedProjectId: (projectId: string) => void;
}

export function createProjectDesktopTopologyNavigation({
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
}: ProjectDesktopTopologyNavigationOptions) {
  const projects = Object.values(projectsById);

  function resolveProject(projectId: string) {
    return projectsById[projectId] ?? resolveRouteProject(projects, projectId);
  }

  function selectProjectContext(projectId: string, groupId?: string) {
    const nextSelectedExplorerTarget: ExplorerTarget = { kind: 'workspace' };
    const nextProject = resolveProject(projectId);
    const nextRecentProjectIds = pushRecentProject(projectId);

    setSelectedExplorerTarget(nextSelectedExplorerTarget);
    setSelectedProjectId(projectId);
    setSelectedMachineId(nextProject?.machineId ?? '');
    setLauncherError('');
    persistProjectsState({
      activeGroupId: nextProject?.groupId ?? groupId ?? '',
      pinnedProjectIds,
      recentProjectIds: nextRecentProjectIds,
      selectedExplorerTarget: nextSelectedExplorerTarget,
      selectedLauncherAppId,
      selectedProjectId: projectId
    });
  }

  return {
    openProjectChat(projectId: string) {
      if (!projectId) return;
      setMainView('chat');
      writeRoute('chat', projectId);
    },
    openProjectIssue(issueNumber: number, projectIdOverride?: string) {
      const targetProjectId = projectIdOverride ?? selectedProjectId;
      if (!targetProjectId || !Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
        return;
      }

      const targetProject = resolveProject(targetProjectId);
      if (!targetProject) {
        return;
      }

      if (targetProjectId !== selectedProjectId) {
        selectProjectContext(targetProjectId, targetProject.groupId);
      }

      setProjectTab('issues');
      setSelectedIssueNumber(issueNumber);
      setMainView('project');
      writeRoute('project', targetProjectId, false, 'issues', String(issueNumber));
    },
    openTopology() {
      if (selectedProjectId) {
        setProjectTab('issues');
        setSelectedIssueNumber(undefined);
        setMainView('project');
        writeRoute('project', selectedProjectId, false, 'issues');
        return;
      }

      setMainView('projects');
      writeRoute('projects');
    },
    selectProject(projectId: string, groupId?: string) {
      selectProjectContext(projectId, groupId);
      setSelectedIssueNumber(undefined);
      setMainView('project');
      writeRoute('project', projectId, false, projectTab);
    }
  };
}
