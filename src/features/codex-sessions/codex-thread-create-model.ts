import type {
  CodexHostInventoryItem,
  CodexHostWorktree
} from '@/shared/codex-host-inventory-api';

export interface IssueWorktreeBinding {
  branch?: string;
  issueNumber: number;
  repository: string;
}

export function codexHostWorktrees(
  host: CodexHostInventoryItem | undefined,
  binding?: IssueWorktreeBinding
) {
  const worktrees = host?.worktrees ?? [];
  if (!binding) return worktrees;
  return worktrees.filter((worktree) => matchesIssueWorktree(worktree, binding));
}

export function issueBoundCodexWorktree(
  host: CodexHostInventoryItem | undefined,
  binding: IssueWorktreeBinding
) {
  const matches = codexHostWorktrees(host, binding);
  return matches.length === 1 ? matches[0] : undefined;
}

function matchesIssueWorktree(
  worktree: CodexHostWorktree,
  binding: IssueWorktreeBinding
) {
  if (worktree.issueNumber !== undefined && worktree.issueNumber !== binding.issueNumber) {
    return false;
  }
  if (worktree.repository !== undefined &&
      worktree.repository.toLowerCase() !== binding.repository.toLowerCase()) {
    return false;
  }
  if (binding.branch && worktree.branch !== undefined && worktree.branch !== binding.branch) {
    return false;
  }

  const hasExactTaskIdentity = worktree.issueNumber === binding.issueNumber &&
    worktree.repository?.toLowerCase() === binding.repository.toLowerCase();
  if (hasExactTaskIdentity) {
    return !binding.branch || worktree.branch === undefined || worktree.branch === binding.branch;
  }

  return Boolean(binding.branch) &&
    (worktree.branch === binding.branch ||
      (worktree.branch === undefined && worktree.label === binding.branch));
}
