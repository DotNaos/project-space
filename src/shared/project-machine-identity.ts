import type { ProjectSpaceRecord } from './project-space-api';

export function projectMachineId(project: ProjectSpaceRecord) {
  const explicitMachineId = project.machineId?.trim();
  if (explicitMachineId) return explicitMachineId;
  if (project.kind === 'github' || !project.id.includes(':')) return 'local';
  return project.id.slice(0, project.id.indexOf(':')) || 'local';
}

export function resolvedProjectMachineId(project: ProjectSpaceRecord, localMachineId: string) {
  const machineId = projectMachineId(project);
  return machineId === 'local' ? localMachineId : machineId;
}
