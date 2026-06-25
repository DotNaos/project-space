import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { toGithubIdea, toLocalIdeaDraft } from '../lib/idea-utils';
import type { IdeaPresentationRecord } from '../lib/idea-utils';
import { useGitHubAuth } from './use-github-auth';
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

function getParentPath(path: string) {
  const normalizedPath = normalizePath(path);
  const lastSlashIndex = normalizedPath.lastIndexOf('/');

  if (lastSlashIndex <= 0) {
    return normalizedPath;
  }

  return normalizedPath.slice(0, lastSlashIndex);
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

function getProjectNavigationView(currentView: ProjectMainView) {
  return currentView === 'worktrees' ? 'worktrees' : 'ideas';
}

function slugifyWorktreeSegment(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
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
  const [isCreatingWorktree, setIsCreatingWorktree] = useState(false);
  const [isCreatingWorktreeSubmitting, setIsCreatingWorktreeSubmitting] = useState(false);
  const [createWorktreeBranchName, setCreateWorktreeBranchNameState] = useState('codex/');
  const [createWorktreeFolderName, setCreateWorktreeFolderNameState] = useState('');
  const [createWorktreeError, setCreateWorktreeError] = useState('');
  const [projectWorktrees, setProjectWorktrees] = useState<
    Record<string, ProjectWorktreeRecord[]>
  >({});
  const [worktreeLoadingByProjectId, setWorktreeLoadingByProjectId] = useState<
    Record<string, boolean>
  >({});
  const [hasLoaded, setHasLoaded] = useState(false);
  const projectWorktreesRef = useRef<Record<string, ProjectWorktreeRecord[]>>({});
  const worktreeLoadingRef = useRef<Record<string, boolean>>({});
  const pendingWorktreeLoadsRef = useRef<Record<string, Promise<ProjectWorktreeRecord[]>>>({});

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
  const isWorktreesLoading = project
    ? !projectWorktrees[project.id] && Boolean(worktreeLoadingByProjectId[project.id])
    : false;
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
  const githubAuth = useGitHubAuth();
  const issueSource = useProjectIssueSource(project);
  const ideas = useProjectIdeas(project, issueSource.config, githubAuth.stateKey);
  const activeSidebarIdeas = useMemo(
    () => ideas.ideas.filter((idea) => idea.githubState !== 'closed'),
    [ideas.ideas]
  );
  const worktreeIdeasById = useMemo<Record<string, IdeaPresentationRecord[]>>(() => {
    const visibleIdeas = activeSidebarIdeas;

    if (worktrees.length === 0 || visibleIdeas.length === 0) {
      return {};
    }

    const ideasById = new Map(visibleIdeas.map((idea) => [idea.id, idea]));
    const assignedIdeaIds = new Set<string>();
    const ideaGroups: Record<string, IdeaPresentationRecord[]> = {};

    for (const worktree of worktrees) {
      if (worktree.isBase) {
        continue;
      }

      const assignedIdeas = worktree.ideaIds
        .map((ideaId) => ideasById.get(ideaId))
        .filter((idea): idea is IdeaPresentationRecord => Boolean(idea));

      assignedIdeas.forEach((idea) => {
        assignedIdeaIds.add(idea.id);
      });

      ideaGroups[worktree.id] = assignedIdeas;
    }

    return ideaGroups;
  }, [activeSidebarIdeas, worktrees]);
  const assignedIdeaIds = useMemo(() => {
    return [
      ...new Set(
        worktrees
          .filter((worktree) => !worktree.isBase)
          .flatMap((worktree) => worktree.ideaIds)
        )
    ];
  }, [worktrees]);
  const unassignedIdeas = useMemo(() => {
    if (activeSidebarIdeas.length === 0) {
      return [];
    }

    const assignedIdeaIdSet = new Set(assignedIdeaIds);

    return activeSidebarIdeas.filter((idea) => !assignedIdeaIdSet.has(idea.id));
  }, [activeSidebarIdeas, assignedIdeaIds]);
  const selectedTargetIdeas = useMemo(() => {
    if (selectedExplorerTarget.kind === 'worktree' && selectedWorktree) {
      return worktreeIdeasById[selectedWorktree.id] ?? [];
    }

    return unassignedIdeas;
  }, [selectedExplorerTarget.kind, selectedWorktree, unassignedIdeas, worktreeIdeasById]);
  const createWorktreeTargetPath = useMemo(() => {
    if (!project) {
      return '';
    }

    const baseWorktree = worktrees.find((worktree) => worktree.isBase);
    const basePath = baseWorktree?.path ?? project.rootPath;

        if (!createWorktreeFolderName.trim()) {
      return '';
    }

    return `${getParentPath(basePath)}/${createWorktreeFolderName.trim()}`;
  }, [createWorktreeFolderName, project, worktrees]);

  useEffect(() => {
    projectWorktreesRef.current = projectWorktrees;
  }, [projectWorktrees]);

  useEffect(() => {
    worktreeLoadingRef.current = worktreeLoadingByProjectId;
  }, [worktreeLoadingByProjectId]);

  const loadWorktreesForProject = useCallback((nextProject: ProjectSpaceRecord) => {
    const cachedWorktrees = projectWorktreesRef.current[nextProject.id];

    if (cachedWorktrees) {
      return Promise.resolve(cachedWorktrees);
    }

    const pendingLoad = pendingWorktreeLoadsRef.current[nextProject.id];

    if (pendingLoad) {
      return pendingLoad;
    }

    setWorktreeLoadingByProjectId((current) => ({
      ...current,
      [nextProject.id]: true
    }));

    const request = window.projectSpace
      .loadProjectWorktrees(nextProject.rootPath)
      .then((nextWorktrees) => {
        setProjectWorktrees((current) => ({
          ...current,
          [nextProject.id]: nextWorktrees
        }));

        return nextWorktrees;
      })
      .finally(() => {
        delete pendingWorktreeLoadsRef.current[nextProject.id];
        setWorktreeLoadingByProjectId((current) => {
          if (!current[nextProject.id]) {
            return current;
          }

          const nextState = { ...current };
          delete nextState[nextProject.id];
          return nextState;
        });
      });

    pendingWorktreeLoadsRef.current[nextProject.id] = request;
    return request;
  }, []);

  const updateIdeaAssignmentInWorktrees = useCallback(
    (projectId: string, ideaId: string, targetWorktreeId?: string) => {
      setProjectWorktrees((current) => {
        const currentProjectWorktrees = current[projectId] ?? [];

        return {
          ...current,
          [projectId]: currentProjectWorktrees.map((worktree) => {
            const nextIdeaIds = worktree.ideaIds.filter((currentIdeaId) => currentIdeaId !== ideaId);

            if (targetWorktreeId && worktree.id === targetWorktreeId) {
              nextIdeaIds.push(ideaId);
            }

            return {
              ...worktree,
              ideaIds: nextIdeaIds
            };
          })
        };
      });
    },
    []
  );

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

    const cachedWorktrees = projectWorktreesRef.current[project.id];

    if (project.kind === 'standalone') {
      if (selectedExplorerTarget.kind !== 'workspace') {
        setSelectedExplorerTarget({ kind: 'workspace' });
      }
    }

    let canceled = false;

    if (
      selectedExplorerTarget.kind === 'worktree' &&
      cachedWorktrees &&
      !cachedWorktrees.some((entry) => entry.id === selectedExplorerTarget.worktreeId)
    ) {
      setSelectedExplorerTarget({ kind: 'workspace' });
    }

    void loadWorktreesForProject(project)
      .then((nextWorktrees) => {
        if (canceled) {
          return;
        }

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
    loadWorktreesForProject,
    selectedExplorerTarget.kind,
    selectedExplorerTarget.kind === 'worktree' ? selectedExplorerTarget.worktreeId : ''
  ]);

  useEffect(() => {
    if (!hasLoaded || navigationItems.length === 0) {
      return;
    }

    const activeIndex = navigationItems.findIndex((entry) => entry.id === activeNavigationItemId);

    if (activeIndex < 0) {
      return;
    }

    const adjacentItems = [navigationItems[activeIndex - 1], navigationItems[activeIndex + 1]].filter(
      (entry): entry is ProjectNavigationItem => Boolean(entry)
    );

    for (const item of adjacentItems) {
      const selection = resolveNavigationSelection(item.id);

      if (!selection?.nextProjectId) {
        continue;
      }

      const adjacentProject = projectsById[selection.nextProjectId];

      if (!adjacentProject) {
        continue;
      }

      if (
        projectWorktreesRef.current[adjacentProject.id] ||
        worktreeLoadingRef.current[adjacentProject.id]
      ) {
        continue;
      }

      void loadWorktreesForProject(adjacentProject);
    }
  }, [
    activeNavigationItemId,
    hasLoaded,
    loadWorktreesForProject,
    navigationItems,
    projectsById
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

  async function openWorktreeInSelectedApp(worktreeId: string) {
    if (!selectedLauncherApp) {
      return;
    }

    const worktree = worktrees.find((entry) => entry.id === worktreeId);

    if (!worktree) {
      return;
    }

    const result = await window.projectSpace.openPathInApp({
      appId: selectedLauncherApp.id,
      path: worktree.path
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

    setMainView('worktrees');
    setIsCreatingWorktree(true);
    setCreateWorktreeError('');
    setCreateWorktreeBranchNameState((current) => {
      if (current.trim()) {
        return current;
      }

      return 'codex/';
    });
  }

  async function createIdea() {
    setMainView('ideas');
    await ideas.createIdea();
  }

  async function exportSelectedIdeaToCurrentWorktree() {
    if (
      !project ||
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

      updateIdeaAssignmentInWorktrees(project.id, ideas.selectedIdea.id, selectedWorktree.id);
      setIdeaExportMessage(`Exported to ${selectedWorktree.name}.`);
    } catch (error) {
      setIdeaExportMessage(
        error instanceof Error ? error.message : 'Could not export the idea to the worktree.'
      );
    } finally {
      setIsIdeaExporting(false);
    }
  }

  async function moveIdeaToWorktree(ideaId: string, targetWorktreeId?: string) {
    if (!project) {
      return;
    }

    const idea = ideas.ideas.find((entry) => entry.id === ideaId);

    if (!idea) {
      return;
    }

    const targetWorktree = targetWorktreeId
      ? worktrees.find((worktree) => worktree.id === targetWorktreeId)
      : undefined;

    await window.projectSpace.moveIdeaToWorktree({
      idea: idea.source === 'github' ? toGithubIdea(idea) : toLocalIdeaDraft(idea),
      targetWorktreePath: targetWorktree?.path,
      worktreePaths: worktrees.map((worktree) => worktree.path)
    });

    updateIdeaAssignmentInWorktrees(project.id, ideaId, targetWorktreeId);
  }

  async function deleteIdea(ideaId: string) {
    if (!project) {
      return;
    }

    const idea = ideas.ideas.find((entry) => entry.id === ideaId);

    if (idea && worktrees.length > 0) {
      await window.projectSpace.moveIdeaToWorktree({
        idea: idea.source === 'github' ? toGithubIdea(idea) : toLocalIdeaDraft(idea),
        targetWorktreePath: undefined,
        worktreePaths: worktrees.map((worktree) => worktree.path)
      });
    }

    updateIdeaAssignmentInWorktrees(project.id, ideaId, undefined);
    await ideas.deleteIdea(ideaId);
  }

  function openIdeasView() {
    setMainView('ideas');
  }

  function openWorktreesView() {
    setMainView('worktrees');
  }

  function cancelCreateWorktree() {
    setIsCreatingWorktree(false);
    setCreateWorktreeError('');
  }

  async function submitCreateWorktree() {
    if (!project) {
      return;
    }

    const nextBranchName = createWorktreeBranchName.trim();
    const nextFolderName = slugifyWorktreeSegment(createWorktreeFolderName);

    if (!nextBranchName) {
      setCreateWorktreeError('Enter a branch name first.');
      return;
    }

    if (!nextFolderName) {
      setCreateWorktreeError('Enter a folder name first.');
      return;
    }

    setIsCreatingWorktreeSubmitting(true);
    setCreateWorktreeError('');

    try {
      const nextWorktrees = await window.projectSpace.createProjectWorktree({
        branchName: nextBranchName,
        projectPath: project.rootPath,
        worktreePathName: nextFolderName
      });

      setProjectWorktrees((current) => ({
        ...current,
        [project.id]: nextWorktrees
      }));

      const createdWorktree = nextWorktrees.find(
        (worktree) => !worktree.isBase && (worktree.branchName?.trim() || worktree.name) === nextBranchName
      );

      setIsCreatingWorktree(false);
      setCreateWorktreeFolderNameState('');
      setLauncherError('');

      if (createdWorktree) {
        setSelectedExplorerTarget({
          kind: 'worktree',
          worktreeId: createdWorktree.id
        });
      }
    } catch (error) {
      setCreateWorktreeError(
        error instanceof Error ? error.message : 'Could not create the worktree.'
      );
    } finally {
      setIsCreatingWorktreeSubmitting(false);
    }
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
    deleteIdea,
    discoveryRoot: discovery.rootPath,
    groups: discovery.groups,
    groupedProjects,
    groupedProjectsLabel: activeGroup?.name,
    hasLoaded,
    ideaDraftValues: ideas.draftValues,
    ideaExportMessage,
    createWorktreeBranchName,
    createWorktreeError,
    createWorktreeFolderName,
    createWorktreeTargetPath,
    githubAuthError: githubAuth.error,
    githubAuthViewer: githubAuth.viewer,
    isGithubAuthenticated: githubAuth.isAuthenticated,
    isGithubConfigured: githubAuth.isConfigured,
    isGithubAuthLoading: githubAuth.isLoading,
    isGithubSigningIn: githubAuth.isSigningIn,
    isGithubSigningOut: githubAuth.isSigningOut,
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
    isCreatingWorktree,
    isCreatingWorktreeSubmitting,
    isWorktreesLoading,
    launcherApps,
    launcherError,
    mainView,
    moveIdeaToWorktree,
    navigationItems,
    openCodexSkills,
    openAppSettings,
    openIssueSource: issueSource.openSource,
    openIdeasView,
    openWorktreesView,
    openProjectSettings,
    openNewWorktreeWorkspace,
    openSelectedTargetInApp,
    openWorktreeInSelectedApp,
    project,
    loadWorktreesForProject,
    projectWorktrees,
    worktreeIdeasById,
    projects: discovery.projects,
    resolveNavigationSelection,
    rootItems: discovery.rootItems,
    signInToGithub: githubAuth.signIn,
    signOutGithub: githubAuth.signOut,
    selectedExplorerTarget,
    selectedIdea: ideas.selectedIdea,
    selectedIdeaId: ideas.selectedIdeaId,
    assignedIdeaIds,
    selectedLauncherApp,
    selectedLauncherAppLabel,
    selectedProjectId,
    selectedTargetName,
    selectedTargetPath,
    selectedTargetIdeas,
    selectedWorktree,
    unassignedIdeas,
    setIssueSourceDraftKind: issueSource.setDraftKind,
    setIssueSourceDraftUrl: issueSource.setDraftUrl,
    saveIssueSourceConfig: issueSource.save,
    setIdeaDraftValue: ideas.setDraftValue,
    setCreateWorktreeBranchName(value: string) {
      setCreateWorktreeBranchNameState(value);
      setCreateWorktreeFolderNameState((current) => {
        if (current.trim()) {
          return current;
        }

        const branchLeaf = value.split('/').filter(Boolean).at(-1) ?? '';
        const projectSlug = slugifyWorktreeSegment(project?.name ?? '');
        const branchSlug = slugifyWorktreeSegment(branchLeaf);

        if (!projectSlug && !branchSlug) {
          return '';
        }

        return [projectSlug, branchSlug].filter(Boolean).join('-');
      });
    },
    setCreateWorktreeFolderName(value: string) {
      setCreateWorktreeFolderNameState(slugifyWorktreeSegment(value));
    },
    saveIdea: ideas.saveIdea,
    submitCreateWorktree,
    settingsTab,
    showClosedIdeas: ideas.showClosedIssues,
    syncErrors: ideas.syncErrors,
    worktrees,
    cancelCreateWorktree,
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

      setMainView(getProjectNavigationView(mainView));
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
      setMainView(getProjectNavigationView(mainView));
      setSelectedExplorerTarget({ kind: 'workspace' });
      setSelectedProjectId(projectId);
      setLauncherError('');
    },
    selectIdea(ideaId: string) {
      setMainView('ideas');
      ideas.setSelectedIdeaId(ideaId);
    },
    selectWorkspace() {
      setMainView('workspace');
      setSelectedExplorerTarget({ kind: 'workspace' });
    },
    selectWorktree(worktreeId: string) {
      setMainView('workspace');
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
