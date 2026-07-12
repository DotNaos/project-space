import { basename } from 'node:path';

import type {
  GitHubCatalogRepository,
  ProjectSpaceBackend,
  ProjectSpaceRecord
} from '../../src/shared/project-space-api';
import { projectChatProjectId } from '../../src/shared/project-chat-project';
import { listMachineMemberships } from '../local-database-store';
import {
  isProjectSpaceAuthRequired,
  runWithAuthSession
} from '../local-auth-store';
import type { ProjectChatContext, ProjectChatProject } from './contracts';

export function createProjectChatProjectProvider({
  backend,
  authRequired = isProjectSpaceAuthRequired,
  membershipsFor = listMachineMemberships
}: {
  backend: Pick<ProjectSpaceBackend, 'getConnectorOverview' | 'getGitHubCatalog' | 'loadProjectDiscovery'>;
  authRequired?(): boolean;
  membershipsFor?(userId: string): Promise<Array<{ machineId: string }>>;
}) {
  const cache = new Map<string, { expiresAt: number; projects: ProjectChatProject[] }>();
  return async function listProjects(context: ProjectChatContext): Promise<ProjectChatProject[]> {
    const accountId = actorAccountId(context);
    if (!accountId) return [];
    const cacheKey = `${accountId}:${context.actor.kind === 'agent' ? context.actor.machineId : 'human'}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return structuredClone(cached.projects);
    }

    const [discovery, overview, catalog] = await Promise.all([
      backend.loadProjectDiscovery(),
      backend.getConnectorOverview().catch(() => ({ machines: [] })),
      loadCatalog(backend, context, accountId)
    ]);
    const allowedMachines = await allowedMachineIds(
      context,
      accountId,
      authRequired(),
      membershipsFor
    );
    const catalogByName = new Map(
      catalog.map((repository) => [repository.fullName.toLowerCase(), repository])
    );
    const machineNames = new Map(
      overview.machines.map((machine) => [machine.id, machine.name])
    );
    const projects = discovery.projects
      .filter(isVisibleProject)
      .filter((project) => !allowedMachines || (
        Boolean(project.machineId) && allowedMachines.has(project.machineId!)
      ))
      .map((project) => projectRecord(project, catalogByName, machineNames));
    const existingIds = new Set(projects.map((project) => project.projectId));
    if (context.actor.kind === 'human') {
      for (const repository of catalog) {
        const projectId = `github:${repository.id}`;
        if (!existingIds.has(projectId)) {
          projects.push({
            displayName: repository.name,
            groupLabel: `@${repository.owner}`,
            navigationProjectId: `github:${repository.fullName}`,
            projectId
          });
        }
      }
    }
    cache.set(cacheKey, {
      expiresAt: Date.now() + 5_000,
      projects: structuredClone(projects)
    });
    return projects;
  };
}

async function loadCatalog(
  backend: Pick<ProjectSpaceBackend, 'getGitHubCatalog'>,
  context: ProjectChatContext,
  accountId: string
) {
  try {
    const result = await runWithAuthSession({
      login: context.actor.kind === 'human' ? context.actor.handle : accountId,
      role: 'user',
      userId: accountId
    }, () => backend.getGitHubCatalog());
    return result.status === 'connected' ? result.repositories : [];
  } catch {
    return [];
  }
}

async function allowedMachineIds(
  context: ProjectChatContext,
  accountId: string,
  requiresAuth: boolean,
  membershipsFor: (userId: string) => Promise<Array<{ machineId: string }>>
) {
  if (context.actor.kind === 'agent') {
    return new Set([context.actor.machineId]);
  }
  if (!requiresAuth) {
    return undefined;
  }
  const memberships = await membershipsFor(accountId);
  return new Set(memberships.map((membership) => membership.machineId));
}

function projectRecord(
  project: ProjectSpaceRecord,
  catalogByName: Map<string, GitHubCatalogRepository>,
  machineNames: Map<string, string>
): ProjectChatProject {
  const catalogRepository = project.github
    ? catalogByName.get(project.github.fullName.toLowerCase())
    : undefined;
  const repository = catalogRepository ?? project.github;
  if (repository) {
    return {
      displayName: repository.name || project.name,
      groupLabel: `@${repository.owner}`,
      navigationProjectId: project.id,
      projectId: projectChatProjectId(project, repository)
    };
  }
  return {
    displayName: project.name,
    groupLabel: project.machineId ? machineNames.get(project.machineId) ?? 'Machine' : 'Local',
    navigationProjectId: project.id,
    projectId: projectChatProjectId(project)
  };
}

function isVisibleProject(project: ProjectSpaceRecord) {
  const folder = basename(project.rootPath || project.name);
  return !folder.startsWith('.') && !folder.endsWith('.worktrees');
}

function actorAccountId(context: ProjectChatContext) {
  return context.actor.kind === 'human' || context.actor.kind === 'agent'
    ? context.actor.accountId
    : undefined;
}
