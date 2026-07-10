import type { FileSystemEntry, MachineFileSystemDirectoryResult } from '@/shared/project-space-api';

export interface ExplorerPathQuery {
  directoryPath: string;
  nameQuery: string;
}

export function normalizeExplorerPath(path: string) {
  const normalized = path.trim().replace(/\/+$/, '');
  return normalized || '/';
}

export function homePathLabel(path: string, homePath: string) {
  if (normalizeExplorerPath(path) === normalizeExplorerPath(homePath)) {
    return '~';
  }
  return path.startsWith(`${homePath}/`) ? `~${path.slice(homePath.length)}` : path;
}

export function enteredPath(value: string, homePath: string) {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '~') {
    return homePath;
  }
  if (trimmed.startsWith('~/')) {
    return `${homePath}/${trimmed.slice(2)}`;
  }
  if (trimmed.startsWith('/')) {
    return trimmed;
  }
  return `${homePath}/${trimmed}`;
}

export function explorerPathQuery(value: string, homePath: string, currentPath: string): ExplorerPathQuery {
  const trimmed = value.trim();
  const absolutePath = enteredPath(trimmed, homePath);

  if (!trimmed || trimmed === '~' || trimmed === '~/') {
    return { directoryPath: normalizeExplorerPath(homePath), nameQuery: '' };
  }

  if (
    trimmed.endsWith('/') ||
    normalizeExplorerPath(absolutePath) === normalizeExplorerPath(currentPath)
  ) {
    return { directoryPath: normalizeExplorerPath(absolutePath), nameQuery: '' };
  }

  const separatorIndex = absolutePath.lastIndexOf('/');
  return {
    directoryPath: separatorIndex <= 0 ? '/' : absolutePath.slice(0, separatorIndex),
    nameQuery: absolutePath.slice(separatorIndex + 1)
  };
}

export function explorerPathSuggestions({
  result,
  nameQuery,
  showHidden,
  limit = 12
}: {
  result: MachineFileSystemDirectoryResult;
  nameQuery: string;
  showHidden: boolean;
  limit?: number;
}) {
  if (result.status === 'error') {
    return [];
  }

  const query = nameQuery.toLocaleLowerCase();
  const explicitlySearchingHidden = nameQuery.startsWith('.');

  return result.entries
    .filter((entry) => showHidden || explicitlySearchingHidden || !entry.name.startsWith('.'))
    .filter((entry) => !query || entry.name.toLocaleLowerCase().includes(query))
    .sort((left, right) => {
      const leftName = left.name.toLocaleLowerCase();
      const rightName = right.name.toLocaleLowerCase();
      const leftStartsWith = leftName.startsWith(query);
      const rightStartsWith = rightName.startsWith(query);

      if (leftStartsWith !== rightStartsWith) {
        return leftStartsWith ? -1 : 1;
      }
      if (left.kind !== right.kind) {
        return left.kind === 'directory' ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    })
    .slice(0, limit);
}

export function completedPathValue(entry: FileSystemEntry, homePath: string) {
  const label = homePathLabel(entry.path, homePath);
  return entry.kind === 'directory' ? `${label.replace(/\/+$/, '')}/` : label;
}

export interface ExplorerBreadcrumb {
  isDirectory: boolean;
  label: string;
  path: string;
}

export function explorerBreadcrumbs({
  homePath,
  path,
  selectedFile = false
}: {
  homePath: string;
  path: string;
  selectedFile?: boolean;
}): ExplorerBreadcrumb[] {
  const normalizedHome = normalizeExplorerPath(homePath);
  const normalizedPath = normalizeExplorerPath(path);

  if (
    normalizedPath !== normalizedHome &&
    !normalizedPath.startsWith(`${normalizedHome}/`)
  ) {
    return [{ isDirectory: !selectedFile, label: normalizedPath, path: normalizedPath }];
  }

  const relativePath = normalizedPath === normalizedHome
    ? ''
    : normalizedPath.slice(normalizedHome.length + 1);
  const parts = relativePath.split('/').filter(Boolean);
  const breadcrumbs: ExplorerBreadcrumb[] = [
    { isDirectory: true, label: '~', path: normalizedHome }
  ];
  let segmentPath = normalizedHome;

  parts.forEach((part, index) => {
    segmentPath = `${segmentPath}/${part}`;
    breadcrumbs.push({
      isDirectory: !selectedFile || index < parts.length - 1,
      label: part,
      path: segmentPath
    });
  });

  return breadcrumbs;
}

export function visibleTreeDirectories(
  entries: FileSystemEntry[] | undefined,
  showHidden: boolean
) {
  return (entries ?? []).filter(
    (entry) =>
      entry.kind === 'directory' &&
      (showHidden || !entry.name.startsWith('.'))
  );
}

export interface VisibleTreeNode {
  depth: number;
  path: string;
}

export function visibleTreeNodes({
  rootEntries,
  expandedPaths,
  resultsByPath,
  showHidden
}: {
  rootEntries: FileSystemEntry[] | undefined;
  expandedPaths: ReadonlySet<string>;
  resultsByPath: ReadonlyMap<string, MachineFileSystemDirectoryResult>;
  showHidden: boolean;
}) {
  const nodes: VisibleTreeNode[] = [];

  function visit(entries: FileSystemEntry[] | undefined, depth: number) {
    for (const entry of visibleTreeDirectories(entries, showHidden)) {
      nodes.push({ depth, path: entry.path });
      if (expandedPaths.has(entry.path)) {
        visit(resultsByPath.get(entry.path)?.entries, depth + 1);
      }
    }
  }

  visit(rootEntries, 0);
  return nodes;
}

export function expansionFrontier(options: Parameters<typeof visibleTreeNodes>[0]) {
  return visibleTreeNodes(options)
    .filter((node) => !options.expandedPaths.has(node.path))
    .map((node) => node.path);
}

export function collapseDeepestExpanded(options: Parameters<typeof visibleTreeNodes>[0]) {
  const expandedNodes = visibleTreeNodes(options).filter((node) =>
    options.expandedPaths.has(node.path)
  );

  if (expandedNodes.length === 0) {
    return new Set(options.expandedPaths);
  }

  const deepestDepth = Math.max(...expandedNodes.map((node) => node.depth));
  const next = new Set(options.expandedPaths);
  for (const node of expandedNodes) {
    if (node.depth === deepestDepth) {
      next.delete(node.path);
    }
  }
  return next;
}
