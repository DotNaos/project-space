import type { ProjectSpaceRecord } from '@/shared/project-space-api';

function normalizeIdentityPart(value: string) {
  return value.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function projectIdentity(project: ProjectSpaceRecord) {
  const repository = project.github?.fullName;
  if (repository) {
    return `github:${normalizeIdentityPart(repository)}`;
  }

  const name = normalizeIdentityPart(project.name);
  if (name) {
    return `local:${name}`;
  }

  return `id:${project.id}`;
}

/**
 * Presents a project once even when multiple machine checkouts report it.
 * Machine-specific state remains available through the task and repository
 * views instead of creating duplicate project-switcher entries.
 */
export function dedupeProjectCatalog(
  projects: ProjectSpaceRecord[],
  preferredProjectId = ''
) {
  const byIdentity = new Map<string, ProjectSpaceRecord>();

  for (const project of projects) {
    const identity = projectIdentity(project);
    const current = byIdentity.get(identity);

    if (!current || project.id === preferredProjectId) {
      byIdentity.set(identity, project);
    }
  }

  return [...byIdentity.values()];
}
