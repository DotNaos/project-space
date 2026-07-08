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
  query,
  visibleViolations,
  violations
}: {
  machine: MachineRecord;
  query?: string;
  visibleViolations?: ProjectStructureViolationRecord[];
  violations: ProjectStructureViolationRecord[];
}) {
  const visibleViolationList = (visibleViolations ?? [])
    .slice(0, 20)
    .map((violation, index) => formatViolationForPrompt(violation, index))
    .join('\n');
  const visibleOmittedCount = Math.max(0, (visibleViolations?.length ?? 0) - 20);
  const violationList = violations
    .slice(0, 40)
    .map((violation, index) => formatViolationForPrompt(violation, index))
    .join('\n');
  const omittedCount = Math.max(0, violations.length - 40);

  return `Inspect these Project Space project-folder structure violations.

Machine: ${machine.name} (${machine.id})

Safety rules:
- You are in read-only diagnosis mode unless the human explicitly confirms one concrete action.
- Do not delete, discard, reset, clean, archive, move, overwrite, or modify files, folders, Git worktrees, branches, uncommitted changes, or local state without explicit user confirmation for that exact action.
- Never run destructive Git commands such as git reset, git clean, branch deletion, or checkout that discards changes.
- If a fix could touch user data or uncommitted changes, explain the risk and ask for confirmation first.
- Prefer read-only inspection and Project CLI validation commands.

Currently visible in the UI${query?.trim() ? ` for search "${query.trim()}"` : ''}:
${visibleViolationList || 'No visible violation rows are currently filtered in.'}${visibleOmittedCount > 0 ? `\n\n${visibleOmittedCount} more visible violations were omitted from this prompt.` : ''}

Violations:
${violationList}${omittedCount > 0 ? `\n\n${omittedCount} more violations were omitted from this prompt.` : ''}

Expected structure:
- ~/projects/{project} is the main worktree and must be a Git repository.
- ~/projects/.worktrees/{project}/{branch} contains additional Git worktrees.
- Random files and non-project folders do not belong directly in ~/projects or .worktrees.
- Items that should be removed must be moved to the projects archive folder, never deleted, and only after explicit confirmation.
- Local POCs that should be kept but are not Project Space projects belong in ~/projects.poc.
- Git repositories in ~/projects should either have a GitHub remote or be intentionally marked as local-only.

Use the Project CLI where possible. Keep replies concise. Explain what you see and propose the smallest safe next step.

When you want the Project Space UI to show accept/decline controls, include a fenced
project-space-actions JSON block after your explanation. Only propose actions from this schema:

\`\`\`project-space-actions
[
  {
    "label": "Short button label",
    "action": "move_to_poc | move_to_trash | initialize_git | keep_local_only",
    "type": "one of the violation types listed above",
    "path": "absolute path from a listed violation",
    "reason": "Why this is the safe next step",
    "risk": "What the user should know before accepting"
  }
]
\`\`\`

Only include actions for violations shown in this prompt. Do not invent paths.`;
}

function formatViolationForPrompt(violation: ProjectStructureViolationRecord, index: number) {
  return [
    `${index + 1}. ${violation.projectName ? `${violation.projectName}: ` : ''}${violation.title} (${violation.type}, ${violation.severity})`,
    `   name: ${violation.name}`,
    `   relative path: ${violation.relativePath}`,
    `   absolute path: ${violation.path}`,
    `   detail: ${violation.detail}`
  ].join('\n');
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
