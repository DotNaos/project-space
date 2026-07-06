import type {
  MachineRecord,
  ProjectSpaceRecord,
  ProjectStructureActionType,
  ProjectStructureViolationRecord,
  ProjectStructureViolationType
} from '@/shared/project-space-api';
import {
  Archive,
  AlertTriangle,
  CircleAlert,
  FolderInput,
  GitBranchPlus,
  HardDrive,
  type LucideIcon
} from 'lucide-react';

const pocMovableTypes = new Set<ProjectStructureViolationType>([
  'root_stray_folder',
  'worktrees_missing_project_layer',
  'orphan_worktree_container',
  'worktree_stray_folder'
]);

export interface ViolationFixOption {
  action: ProjectStructureActionType;
  disabledReason?: string;
  description: string;
  icon: LucideIcon;
  label: string;
  requestType: ProjectStructureViolationType;
}

const fixActions: Array<Omit<ViolationFixOption, 'disabledReason' | 'requestType'>> = [
  {
    action: 'move_to_poc',
    description: 'Keep it locally, outside the Project Space root.',
    icon: FolderInput,
    label: 'Move to POCs'
  },
  {
    action: 'move_to_trash',
    description: 'Move it into the project archive folder.',
    icon: Archive,
    label: 'Move to Archive'
  },
  {
    action: 'initialize_git',
    description: 'Turn this folder into a Git repository.',
    icon: GitBranchPlus,
    label: 'Initialize Git'
  },
  {
    action: 'keep_local_only',
    description: 'Mark this repository as intentionally local.',
    icon: HardDrive,
    label: 'Keep local only'
  }
];

function dirname(path: string) {
  const normalizedPath = path.replace(/\/+$/, '');
  const index = normalizedPath.lastIndexOf('/');

  return index > 0 ? normalizedPath.slice(0, index) : normalizedPath;
}

export function projectsRootFromViolations(violations: ProjectStructureViolationRecord[]) {
  const firstViolation = violations[0];

  if (!firstViolation) {
    return '';
  }

  return firstViolation.relativePath
    .split('/')
    .filter(Boolean)
    .reduce((path) => dirname(path), firstViolation.path);
}

export function codexSystemPromptForViolations({
  machine,
  violations
}: {
  machine: MachineRecord;
  violations: ProjectStructureViolationRecord[];
}) {
  const violationList = violations
    .slice(0, 40)
    .map(
      (violation, index) =>
        `${index + 1}. ${violation.title} (${violation.type})\n   path: ${violation.path}\n   detail: ${violation.detail}`
    )
    .join('\n');
  const omittedCount = Math.max(0, violations.length - 40);

  return `Fix these Project Space project-folder structure violations.

Machine: ${machine.name} (${machine.id})

Violations:
${violationList}${omittedCount > 0 ? `\n\n${omittedCount} more violations were omitted from this prompt.` : ''}

Expected structure:
- ~/projects/{project} is the main worktree and must be a Git repository.
- ~/projects/.worktrees/{project}/{branch} contains additional Git worktrees.
- Random files and non-project folders do not belong directly in ~/projects or .worktrees.
- Items that should be removed must be moved to the projects archive folder, not deleted.
- Local POCs that should be kept but are not Project Space projects belong in ~/projects.poc.
- Git repositories in ~/projects should either have a GitHub remote or be intentionally marked as local-only.

Use the Project CLI where possible, make the smallest safe change, and validate the result with project validate.
Keep replies concise and report what you changed or what you need next.`;
}

export function fixOptionsForViolation(
  violation: ProjectStructureViolationRecord
): ViolationFixOption[] {
  return fixActions.map((option) => ({
    ...option,
    disabledReason: disabledReasonForViolationAction(option.action, violation),
    requestType: violation.type
  }));
}

function disabledReasonForViolationAction(
  action: ProjectStructureActionType,
  violation: ProjectStructureViolationRecord
) {
  if (action === 'move_to_trash') {
    return undefined;
  }

  if (action === 'move_to_poc') {
    return pocMovableTypes.has(violation.type)
      ? undefined
      : 'Only folders that should stay local can move to POCs.';
  }

  if (action === 'initialize_git') {
    if (violation.type === 'root_stray_folder') {
      return undefined;
    }

    return violation.type === 'git_repo_missing_github_remote'
      ? 'Git is already initialized.'
      : 'Only root folders can be initialized here.';
  }

  if (action === 'keep_local_only') {
    return violation.type === 'git_repo_missing_github_remote'
      ? undefined
      : 'Only Git repositories without a GitHub remote can be marked local-only.';
  }

  return 'Not available for this problem.';
}

export function fixOptionsForProject(
  project: ProjectSpaceRecord,
  projectViolations: ProjectStructureViolationRecord[]
): ViolationFixOption[] {
  const noGitHubRemoteViolation = projectViolations.find(
    (violation) => violation.type === 'git_repo_missing_github_remote'
  );

  return fixActions.map((option) => ({
    ...option,
    disabledReason: disabledReasonForProjectAction(option.action, project, noGitHubRemoteViolation),
    requestType: noGitHubRemoteViolation?.type ?? 'root_stray_folder'
  }));
}

function disabledReasonForProjectAction(
  action: ProjectStructureActionType,
  project: ProjectSpaceRecord,
  noGitHubRemoteViolation?: ProjectStructureViolationRecord
) {
  if (action === 'move_to_trash' || action === 'move_to_poc') {
    return undefined;
  }

  if (action === 'initialize_git') {
    return project.gitStatus ? 'Git is already initialized.' : undefined;
  }

  if (action === 'keep_local_only') {
    if (!project.gitStatus) {
      return 'This folder is not a Git repository yet.';
    }

    return noGitHubRemoteViolation
      ? undefined
      : 'This repository is already connected or marked local-only.';
  }

  return 'Not available for this project.';
}

export function projectViolationTone(violations: ProjectStructureViolationRecord[]) {
  return violations.some((violation) => violation.severity === 'error')
    ? {
        icon: CircleAlert,
        text: 'text-red-300'
      }
    : {
        icon: AlertTriangle,
        text: 'text-amber-300'
      };
}

export function matchesMachineProjectQuery({
  project,
  query,
  violations
}: {
  project: ProjectSpaceRecord;
  query: string;
  violations: ProjectStructureViolationRecord[];
}) {
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedQuery) {
    return true;
  }

  return [
    project.name,
    project.rootPath,
    project.kind,
    project.gitStatus?.branchName,
    ...violations.flatMap((violation) => [
      violation.name,
      violation.relativePath,
      violation.title,
      violation.detail,
      violation.type
    ])
  ].some((value) => value?.toLowerCase().includes(normalizedQuery));
}

export function matchesViolationQuery(
  violation: ProjectStructureViolationRecord,
  query: string
) {
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedQuery) {
    return true;
  }

  return [
    violation.name,
    violation.relativePath,
    violation.title,
    violation.detail,
    violation.type
  ].some((value) => value.toLowerCase().includes(normalizedQuery));
}
