import { useEffect, useMemo, useState } from 'react';
import { launcherAppLabels } from '@/shared/electron-api';
import type {
  ExplorerTarget,
  LauncherAppRecord,
  ProjectDiscoveryResult,
  ProjectNavigationItem,
  ProjectSpaceRecord,
  ProjectWorktreeRecord
} from '@/shared/electron-api';
import type { ProjectMainView } from '../components/project-main-panel';
import type { SettingsTab } from '../components/project-settings-panel';
import { toGithubIdea } from '../lib/idea-utils';
import { useProjectIssueSource } from './use-project-issue-source';
import { useProjectIdeas } from './use-project-ideas';

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
  const [mainView, setMainView] = useState<ProjectMainView>('ideas');
  const [discovery, setDiscovery] = useState<ProjectDiscoveryResult>(emptyDiscovery);
  const [selectedExplorerTarget, setSelectedExplorerTarget] = useState<ExplorerTarget>({
    kind: 'workspace'
  });
  const [selectedLauncherAppId, setSelectedLauncherAppId] = useState('');
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('project');
  const [launcherApps, setLauncherApps] = useState<LauncherAppRecord[]>([]);
  const [launcherError, setLauncherError] = useState('');
  const [ideaExportMessage, setIdeaExportMessage] = useState('');
  const [isIdeaExporting, setIsIdeaExporting] = useState(false);
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
  const issueSource = useProjectIssueSource(project);
  const ideas = useProjectIdeas(project, issueSource.config);

  useEffect(() => {
    void Promise.all([
      window.projectSpace.loadProjectsState(),
      window.projectSpace.loadProjectDiscovery()
    ])
      .then(([state, nextDiscovery]) => {
        setDiscovery(nextDiscovery);
        setSelectedExplorerTarget(state.selectedExplorerTarget);
        setSelectedLauncherAppId(state.selectedLauncherAppId);
        setSelectedProjectId(state.selectedProjectId);
      })
      .finally(() => {
        setHasLoaded(true);
      });
  }, []);

  useEffect(() => {
    let canceled = false;

    void window.projectSpace.loadLauncherApps().then((nextLauncherApps) => {
      if (canceled) {
        return;
      }

      setLauncherApps(nextLauncherApps);
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
      activeGroupId: project?.groupId ?? '',
      selectedExplorerTarget,
      selectedLauncherAppId,
      selectedProjectId
    });
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
    setMainView('ideas');
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

  async function openCodexSkills() {
    const result = await window.projectSpace.openCodexSkills();

    setLauncherError(
      result.status === 'error' ? result.message ?? 'Could not open the skills folder.' : ''
    );
  }

  async function openNewWorktreeWorkspace() {
    if (!project) {
      return;
    }

    const result = await window.projectSpace.openPathInApp({
      appId: 'terminal',
      path: project.rootPath
    });

    setLauncherError(
      result.status === 'error'
        ? result.message ?? 'Could not open the project in Terminal.'
        : ''
    );
  }

  async function createIdea() {
    setMainView('ideas');
    await ideas.createIdea();
  }

  async function exportSelectedIdeaToCurrentWorktree() {
    if (
      !selectedWorktree ||
      !ideas.selectedIdea ||
      ideas.selectedIdea.source !== 'github' ||
      !ideas.selectedIdea.qualityGate.isReady
    ) {
      return;
    }

    setIsIdeaExporting(true);
    setIdeaExportMessage('');

    try {
      await window.projectSpace.exportIdeasToWorktree({
        ideas: [toGithubIdea(ideas.selectedIdea)],
        worktreePath: selectedWorktree.path
      });

      setIdeaExportMessage(`Exported to ${selectedWorktree.name}.`);
    } catch (error) {
      setIdeaExportMessage(
        error instanceof Error ? error.message : 'Could not export the idea to the worktree.'
      );
    } finally {
      setIsIdeaExporting(false);
    }
  }

  function openIdeasView() {
    setMainView('ideas');
  }

  function openProjectSettings() {
    setSettingsTab('project');
    setMainView('settings');
  }

  function openAppSettings() {
    setSettingsTab('app');
    setMainView('settings');
  }

  return {
    activeGroup,
    activeNavigationItemId,
    createIdea,
    createProject,
    discoveryRoot: discovery.rootPath,
    groups: discovery.groups,
    groupedProjects,
    groupedProjectsLabel: activeGroup?.name,
    ideaDraftValues: ideas.draftValues,
    ideaExportMessage,
    issueSourceConfig: issueSource.config,
    issueSourceDraftKind: issueSource.draftKind,
    issueSourceDraftUrl: issueSource.draftUrl,
    issueSourceError: issueSource.error,
    ideas: ideas.ideas,
    ideasLoadError: ideas.loadError,
    exportSelectedIdeaToCurrentWorktree,
    isIssueSourceLoading: issueSource.isLoading,
    isIssueSourceSaving: issueSource.isSaving,
    isIdeaExporting,
    isIdeaSaving: ideas.isSaving,
    isIdeasDirty: ideas.isDirty,
    isIdeasLoading: ideas.isLoading,
    launcherApps,
    launcherError,
    mainView,
    navigationItems,
    openCodexSkills,
    openAppSettings,
    openIssueSource: issueSource.openSource,
    openIdeasView,
    openProjectSettings,
    openNewWorktreeWorkspace,
    openSelectedTargetInApp,
    project,
    projects: discovery.projects,
    resolveNavigationSelection,
    rootItems: discovery.rootItems,
    selectedExplorerTarget,
    selectedIdea: ideas.selectedIdea,
    selectedIdeaId: ideas.selectedIdeaId,
    selectedLauncherApp,
    selectedLauncherAppLabel,
    selectedProjectId,
    selectedTargetName,
    selectedTargetPath,
    selectedWorktree,
    setIssueSourceDraftKind: issueSource.setDraftKind,
    setIssueSourceDraftUrl: issueSource.setDraftUrl,
    saveIssueSourceConfig: issueSource.save,
    setIdeaDraftValue: ideas.setDraftValue,
    saveIdea: ideas.saveIdea,
    settingsTab,
    showClosedIdeas: ideas.showClosedIssues,
    syncErrors: ideas.syncErrors,
    worktrees,
    setShowClosedIdeas: ideas.setShowClosedIssues,
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

      setMainView('ideas');
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
    selectProject(projectId: string, groupId?: string) {
      setMainView('ideas');
      setSelectedExplorerTarget({ kind: 'workspace' });
      setSelectedProjectId(projectId);
      setLauncherError('');
    },
    selectIdea(ideaId: string) {
      setMainView('ideas');
      ideas.setSelectedIdeaId(ideaId);
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
    setSettingsTab,
    clearLauncherError() {
      setLauncherError('');
    }
  };
}
