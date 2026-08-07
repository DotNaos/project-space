import type { GitHubCatalogStatus } from './project-space-api';

export interface GitHubTreeEntry {
  /** Byte size for blobs. Trees do not report one. */
  size?: number;
  path: string;
  sha: string;
  type: 'blob' | 'tree';
}

export interface GitHubRepositoryTreeResult {
  checkedAt: string;
  entries: GitHubTreeEntry[];
  message?: string;
  ref: string;
  status: GitHubCatalogStatus;
  /** GitHub stops at 100k entries and reports the cut. */
  truncated: boolean;
}

export interface GitHubRepositoryFileResult {
  /** Absent when the blob is binary or above the size limit. */
  content?: string;
  encoding: 'none' | 'utf-8';
  message?: string;
  path: string;
  ref: string;
  size: number;
  status: GitHubCatalogStatus;
}

export const githubRepositoryFileMaximumBytes = 512 * 1024;

/** GitHub serves a tree in flat path order; the inspector needs it nested. */
export interface GitHubTreeNode extends GitHubTreeEntry {
  children: GitHubTreeNode[];
  name: string;
}

export function buildGitHubTreeNodes(entries: readonly GitHubTreeEntry[]): GitHubTreeNode[] {
  const roots: GitHubTreeNode[] = [];
  const byPath = new Map<string, GitHubTreeNode>();
  const ordered = [...entries].sort((left, right) => left.path.localeCompare(right.path));

  for (const entry of ordered) {
    const segments = entry.path.split('/');
    const name = segments.at(-1) ?? entry.path;
    const node: GitHubTreeNode = { ...entry, children: [], name };
    byPath.set(entry.path, node);
    const parentPath = segments.slice(0, -1).join('/');
    const parent = parentPath ? byPath.get(parentPath) : undefined;
    if (parentPath && !parent) continue; // A truncated tree can omit the parent.
    (parent ? parent.children : roots).push(node);
  }

  const sortNodes = (nodes: GitHubTreeNode[]) => {
    nodes.sort((left, right) =>
      Number(left.type === 'blob') - Number(right.type === 'blob') ||
      left.name.localeCompare(right.name)
    );
    for (const node of nodes) sortNodes(node.children);
  };
  sortNodes(roots);
  return roots;
}
