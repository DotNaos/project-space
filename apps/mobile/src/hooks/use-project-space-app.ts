import { useEffect, useMemo, useState } from 'react';

import type {
  AuthSession,
  GitHubRepository,
  ProjectIdea,
  SelectedProject,
} from '../domain/models';
import {
  clearPersistedAppState,
  loadPersistedAppState,
  persistAppState,
} from '../services/app-storage-service';
import {
  clearOAuthCallbackParams,
  consumeOAuthSession,
  fetchAuthHealth,
  readOAuthCallbackParams,
} from '../services/github-auth-service';
import { fetchRepositories, fetchViewer } from '../services/github-api-service';

function createIdeaId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function useProjectSpaceApp() {
  const [isBooting, setIsBooting] = useState(true);
  const [authSession, setAuthSession] = useState<AuthSession | null>(null);
  const [selectedProjects, setSelectedProjects] = useState<SelectedProject[]>([]);
  const [ideasByRepositoryId, setIdeasByRepositoryId] = useState<
    Record<string, ProjectIdea[]>
  >({});
  const [availableRepositories, setAvailableRepositories] = useState<
    GitHubRepository[]
  >([]);
  const [activeProjectId, setActiveProjectId] = useState<number | null>(null);
  const [isFetchingRepositories, setIsFetchingRepositories] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [repositoriesError, setRepositoriesError] = useState<string | null>(null);
  const [isSelectingProjects, setIsSelectingProjects] = useState(false);
  const [authHealth, setAuthHealth] = useState<{
    configured: boolean;
    callbackUrl: string;
  } | null>(null);

  useEffect(() => {
    let isCancelled = false;

    async function bootstrap() {
      try {
        const [storedState, health] = await Promise.all([
          loadPersistedAppState(),
          fetchAuthHealth().catch(() => null),
        ]);

        if (isCancelled) {
          return;
        }

        setAuthHealth(health);

        const callbackParams = readOAuthCallbackParams();
        let resolvedAuthSession = storedState.authSession;

        if (callbackParams.error) {
          setAuthError(callbackParams.error);
          clearOAuthCallbackParams();
        }

        if (callbackParams.sessionId) {
          try {
            resolvedAuthSession = await consumeOAuthSession(callbackParams.sessionId);
            clearOAuthCallbackParams();
          } catch (error) {
            setAuthError(
              error instanceof Error ? error.message : 'GitHub login failed.'
            );
            clearOAuthCallbackParams();
          }
        } else if (storedState.authSession) {
          try {
            const viewer = await fetchViewer(storedState.authSession.accessToken);
            resolvedAuthSession = {
              ...storedState.authSession,
              viewer,
            };
          } catch {
            resolvedAuthSession = null;
          }
        }

        if (isCancelled) {
          return;
        }

        setAuthSession(resolvedAuthSession);
        setSelectedProjects(storedState.selectedProjects);
        setIdeasByRepositoryId(storedState.ideasByRepositoryId);
        setActiveProjectId(storedState.selectedProjects[0]?.repository.id ?? null);
        setIsSelectingProjects(
          Boolean(resolvedAuthSession) && storedState.selectedProjects.length === 0
        );

        if (resolvedAuthSession) {
          await persistAppState({
            authSession: resolvedAuthSession,
            selectedProjects: storedState.selectedProjects,
            ideasByRepositoryId: storedState.ideasByRepositoryId,
          });
        }
      } finally {
        if (!isCancelled) {
          setIsBooting(false);
        }
      }
    }

    void bootstrap();

    return () => {
      isCancelled = true;
    };
  }, []);

  useEffect(() => {
    if (isBooting) {
      return;
    }

    void persistAppState({
      authSession,
      selectedProjects,
      ideasByRepositoryId,
    });
  }, [authSession, ideasByRepositoryId, isBooting, selectedProjects]);

  useEffect(() => {
    if (!authSession || !isSelectingProjects || availableRepositories.length > 0) {
      return;
    }

    void loadRepositories();
  }, [authSession, availableRepositories.length, isSelectingProjects]);

  const activeProject = useMemo(
    () =>
      selectedProjects.find((project) => project.repository.id === activeProjectId) ??
      selectedProjects[0] ??
      null,
    [activeProjectId, selectedProjects]
  );

  async function loadRepositories(force = false) {
    if (!authSession) {
      return;
    }

    if (availableRepositories.length > 0 && !force) {
      return;
    }

    setRepositoriesError(null);
    setIsFetchingRepositories(true);

    try {
      const repositories = await fetchRepositories(authSession.accessToken);
      setAvailableRepositories(repositories);
    } catch (error) {
      setRepositoriesError(
        error instanceof Error
          ? error.message
          : 'Repositories could not be loaded.'
      );
    } finally {
      setIsFetchingRepositories(false);
    }
  }

  function saveSelectedProjects(nextProjects: SelectedProject[]) {
    setSelectedProjects(nextProjects);
    setIsSelectingProjects(false);
    setActiveProjectId(nextProjects[0]?.repository.id ?? null);
  }

  function addIdea(repositoryId: number, title: string, description: string) {
    const normalizedTitle = title.trim();
    const normalizedDescription = description.trim();

    if (!normalizedTitle) {
      throw new Error('An idea title is required.');
    }

    const nextIdea: ProjectIdea = {
      id: createIdeaId(),
      title: normalizedTitle,
      description: normalizedDescription,
      createdAt: new Date().toISOString(),
    };

    setIdeasByRepositoryId((current) => ({
      ...current,
      [String(repositoryId)]: [nextIdea, ...(current[String(repositoryId)] ?? [])],
    }));
  }

  async function signOut() {
    setAuthSession(null);
    setSelectedProjects([]);
    setIdeasByRepositoryId({});
    setAvailableRepositories([]);
    setActiveProjectId(null);
    setAuthError(null);
    setRepositoriesError(null);
    setIsSelectingProjects(false);
    await clearPersistedAppState();
  }

  return {
    isBooting,
    authSession,
    authHealth,
    authError,
    repositoriesError,
    availableRepositories,
    selectedProjects,
    activeProject,
    activeProjectId,
    ideasByRepositoryId,
    isFetchingRepositories,
    isSelectingProjects,
    setActiveProjectId,
    setAuthError,
    setIsSelectingProjects,
    loadRepositories,
    saveSelectedProjects,
    addIdea,
    signOut,
  };
}
