import type {
  GitHubCatalogRepository,
  MachineRecord,
  ProjectSpaceRecord
} from '@/shared/project-space-api';
import type { MachineWorktreeInfo } from '../hooks/use-machine-worktree-discovery';
import type { CloneTargetInfo, MachineProjectCheckout } from './project-machine-checkout-model';

export interface ConnectorCloneTargetState {
  error?: string;
  targets: Record<string, CloneTargetInfo>;
}

export function basename(path: string) {
  return path.split('/').filter(Boolean).pop() ?? path;
}

export function normalizeConnectorKey(value: string) {
  return value.trim().replace(/^@/, '').toLowerCase();
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function escapeDoubleQuotedShell(value: string) {
  return value.replace(/["\\$`]/g, (character) => `\\${character}`);
}

export function canonicalProjectName(
  project: ProjectSpaceRecord,
  repository?: GitHubCatalogRepository
) {
  return repository?.name || project.github?.name || project.name.split('/').pop() || basename(project.rootPath);
}

export function defaultBranchName(
  project: ProjectSpaceRecord,
  repository?: GitHubCatalogRepository
) {
  return repository?.defaultBranch || project.github?.defaultBranch || 'main';
}

export function isDefaultBranch(branchName: string | undefined, defaultBranch: string) {
  return normalizeConnectorKey(branchName || '') === normalizeConnectorKey(defaultBranch);
}

export function canRunConnectorCommand(connector?: MachineRecord) {
  return connector?.connector.status === 'local' || connector?.connector.status === 'online';
}

export function cloneUrl(repository?: GitHubCatalogRepository) {
  if (!repository) return '';
  if (repository.fullName) return `git@github.com:${repository.fullName}.git`;
  return repository.url.endsWith('.git') ? repository.url : `${repository.url}.git`;
}

function cloneTargetExpressionForBranch(
  repositoryName: string,
  branchName: string,
  defaultBranch: string
) {
  const projectPath = escapeDoubleQuotedShell(repositoryName);
  const worktreePath = escapeDoubleQuotedShell(`${repositoryName}/${branchName}`);
  return isDefaultBranch(branchName, defaultBranch)
    ? `$HOME/projects/${projectPath}`
    : `$HOME/projects/.worktrees/${worktreePath}`;
}

export function createCloneTargetProbeCommand(
  branchNames: string[],
  defaultBranch: string,
  repositoryName: string
) {
  return [
    'set -e',
    ...branchNames.flatMap((branch) => [
      `target="${cloneTargetExpressionForBranch(repositoryName, branch, defaultBranch)}"`,
      'if [ -e "$target" ]; then exists=1; else exists=0; fi',
      `printf '%s\\t%s\\t%s\\n' ${shellQuote(branch)} "$exists" "$target"`
    ])
  ].join('\n');
}

export function compactHomePath(path: string | undefined) {
  if (!path) return '';
  return path.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
}

export function createCloneCommand({
  branchName,
  defaultBranch,
  repository,
  repositoryName
}: {
  branchName: string;
  defaultBranch: string;
  repository: string;
  repositoryName: string;
}) {
  const projectPath = escapeDoubleQuotedShell(repositoryName);
  const worktreePath = escapeDoubleQuotedShell(`${repositoryName}/${branchName}`);

  if (isDefaultBranch(branchName, defaultBranch)) {
    return [
      'set -e',
      `target="$HOME/projects/${projectPath}"`,
      'if [ -e "$target" ]; then echo "Target already exists: $target"; exit 1; fi',
      'mkdir -p "${target%/*}"',
      `git clone --branch ${shellQuote(branchName)} ${shellQuote(repository)} "$target"`
    ].join('\n');
  }

  return [
    'set -e',
    `base="$HOME/projects/${projectPath}"`,
    `target="$HOME/projects/.worktrees/${worktreePath}"`,
    'if [ -e "$target" ]; then echo "Target already exists: $target"; exit 1; fi',
    'if [ ! -d "$base/.git" ]; then',
    '  mkdir -p "${base%/*}"',
    `  git clone --branch ${shellQuote(defaultBranch)} ${shellQuote(repository)} "$base"`,
    'fi',
    'mkdir -p "${target%/*}"',
    'cd "$base"',
    `git fetch origin ${shellQuote(branchName)}`,
    `if git show-ref --verify --quiet ${shellQuote(`refs/heads/${branchName}`)}; then`,
    `  git worktree add "$target" ${shellQuote(branchName)}`,
    'else',
    `  git worktree add --track -b ${shellQuote(branchName)} "$target" ${shellQuote(`origin/${branchName}`)}`,
    'fi'
  ].join('\n');
}

export function connectorStatusClass(status?: string) {
  return status === 'local' || status === 'online' ? 'text-emerald-300' : 'text-neutral-500';
}

export function checkoutSortValue(checkout: MachineProjectCheckout) {
  return checkout.kind === 'main' ? `0:${checkout.path}` : `1:${checkout.branchName ?? checkout.path}`;
}

export function primaryCheckout(checkouts: MachineProjectCheckout[]) {
  return checkouts.find((checkout) => checkout.kind === 'main') ??
    [...checkouts].sort((left, right) => checkoutSortValue(left).localeCompare(checkoutSortValue(right)))[0];
}

function branchSortValue(defaultBranch: string) {
  return (left: string, right: string) => {
    if (isDefaultBranch(left, defaultBranch)) return -1;
    if (isDefaultBranch(right, defaultBranch)) return 1;
    return left.localeCompare(right);
  };
}

export function mergeBranchNames(
  defaultBranch: string,
  remoteBranches: string[],
  worktrees: MachineWorktreeInfo[]
) {
  const branches = new Set<string>(remoteBranches);
  for (const worktree of worktrees) branches.add(worktree.branchName || worktree.name);
  return Array.from(branches).sort(branchSortValue(defaultBranch));
}
