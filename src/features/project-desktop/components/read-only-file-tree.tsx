import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronRight,
  ChevronsDown,
  ChevronsUp,
  Folder,
  FolderOpen,
  LoaderCircle,
  ShieldAlert,
  Star
} from 'lucide-react';
import { Button, Text } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import type { FileSystemEntry, MachineFileSystemDirectoryResult } from '@/shared/project-space-api';
import {
  collapseDeepestExpanded,
  expansionFrontier,
  isHiddenFileSystemName,
  visibleTreeDirectories
} from './machine-explorer-model';

interface ReadOnlyFileTreeProps {
  currentPath: string;
  defaultPath: string;
  homePath: string;
  loadDirectory(path: string): Promise<MachineFileSystemDirectoryResult>;
  onOpenDefault(): void;
  onOpenContextMenu(entry: FileSystemEntry, clientX: number, clientY: number): void;
  onOpenDirectory(path: string): void;
  refreshVersion: number;
  showHidden: boolean;
}

interface DirectoryNodeProps {
  currentPath: string;
  entry: FileSystemEntry;
  expandedPaths: ReadonlySet<string>;
  level: number;
  loadingPaths: ReadonlySet<string>;
  onOpenContextMenu(entry: FileSystemEntry, clientX: number, clientY: number): void;
  onToggle(entry: FileSystemEntry): void;
  resultsByPath: ReadonlyMap<string, MachineFileSystemDirectoryResult>;
  showHidden: boolean;
}

function isSelected(currentPath: string, path: string) {
  return currentPath.replace(/\/+$/, '') === path.replace(/\/+$/, '');
}

async function loadWithConcurrencyLimit(
  paths: string[],
  load: (path: string) => Promise<MachineFileSystemDirectoryResult>,
  concurrency = 4
) {
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < paths.length) {
      const path = paths[nextIndex];
      nextIndex += 1;
      if (path) {
        await load(path);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, paths.length) }, () => worker())
  );
}

function DirectoryNode({
  currentPath,
  entry,
  expandedPaths,
  level,
  loadingPaths,
  onOpenContextMenu,
  onToggle,
  resultsByPath,
  showHidden
}: DirectoryNodeProps) {
  const expanded = expandedPaths.has(entry.path);
  const loading = loadingPaths.has(entry.path);
  const result = resultsByPath.get(entry.path);
  const selected = isSelected(currentPath, entry.path);
  const hidden = isHiddenFileSystemName(entry.name);
  const directories = visibleTreeDirectories(result?.entries, showHidden);

  return (
    <div>
      <button
        aria-expanded={expanded}
        type="button"
        onClick={() => onToggle(entry)}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onOpenContextMenu(entry, event.clientX, event.clientY);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            event.preventDefault();
            const bounds = event.currentTarget.getBoundingClientRect();
            onOpenContextMenu(entry, bounds.left + 28, bounds.top + bounds.height / 2);
          }
        }}
        className={cn(
          'group flex min-h-9 w-full min-w-0 items-center gap-2 rounded-md pr-2 text-left text-sm transition',
          selected
            ? hidden
              ? 'bg-neutral-800 text-neutral-300'
              : 'bg-neutral-800 text-neutral-50'
            : hidden
              ? 'text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200'
              : 'text-neutral-300 hover:bg-neutral-900 hover:text-neutral-100'
        )}
        style={{ paddingLeft: `${level * 15 + 10}px` }}
      >
        <ChevronRight
          className={cn('size-3.5 shrink-0 text-neutral-600 transition-transform', expanded && 'rotate-90')}
        />
        {expanded ? (
          <FolderOpen
            className={cn(
              'size-4 shrink-0',
              hidden ? 'text-neutral-500' : 'text-neutral-300'
            )}
          />
        ) : (
          <Folder
            className={cn(
              'size-4 shrink-0',
              hidden
                ? 'text-neutral-700 group-hover:text-neutral-500'
                : 'text-neutral-500 group-hover:text-neutral-300'
            )}
          />
        )}
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
        {loading ? <LoaderCircle className="size-3.5 shrink-0 animate-spin text-neutral-500" /> : null}
      </button>

      {expanded ? (
        <div>
          {result?.status === 'error' ? (
            <div
              className="flex items-center gap-2 py-1.5 text-xs text-rose-300/80"
              style={{ paddingLeft: `${(level + 1) * 15 + 30}px` }}
            >
              <ShieldAlert className="size-3.5 shrink-0" />
              <span className="truncate">Inaccessible</span>
            </div>
          ) : directories.length > 0 ? (
            directories.map((child) => (
              <DirectoryNode
                key={child.path}
                currentPath={currentPath}
                entry={child}
                expandedPaths={expandedPaths}
                level={level + 1}
                loadingPaths={loadingPaths}
                onOpenContextMenu={onOpenContextMenu}
                onToggle={onToggle}
                resultsByPath={resultsByPath}
                showHidden={showHidden}
              />
            ))
          ) : result?.status === 'success' ? (
            <Text
              className="block py-1.5 text-xs text-neutral-600"
              style={{ paddingLeft: `${(level + 1) * 15 + 30}px` }}
            >
              Empty
            </Text>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ReadOnlyFileTree({
  currentPath,
  defaultPath,
  homePath,
  loadDirectory,
  onOpenDefault,
  onOpenContextMenu,
  onOpenDirectory,
  refreshVersion,
  showHidden
}: ReadOnlyFileTreeProps) {
  const resultsRef = useRef(new Map<string, MachineFileSystemDirectoryResult>());
  const pendingRef = useRef(new Map<string, Promise<MachineFileSystemDirectoryResult>>());
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(() => new Set());
  const [resultsByPath, setResultsByPath] = useState<Map<string, MachineFileSystemDirectoryResult>>(
    () => new Map()
  );
  const [root, setRoot] = useState<MachineFileSystemDirectoryResult>();
  const [loading, setLoading] = useState(true);

  const ensureLoaded = useCallback(
    async (path: string) => {
      const cached = resultsRef.current.get(path);
      if (cached) {
        return cached;
      }

      const pending = pendingRef.current.get(path);
      if (pending) {
        return pending;
      }

      setLoadingPaths((current) => new Set(current).add(path));
      const request = loadDirectory(path)
        .catch(() => ({
          entries: [],
          message: 'The machine connector is not available right now.',
          path,
          status: 'error' as const
        }))
        .then((result) => {
          resultsRef.current.set(path, result);
          setResultsByPath(new Map(resultsRef.current));
          return result;
        })
        .finally(() => {
          pendingRef.current.delete(path);
          setLoadingPaths((current) => {
            const next = new Set(current);
            next.delete(path);
            return next;
          });
        });

      pendingRef.current.set(path, request);
      return request;
    },
    [loadDirectory]
  );

  useEffect(() => {
    let canceled = false;
    resultsRef.current = new Map();
    pendingRef.current = new Map();
    setResultsByPath(new Map());
    setExpandedPaths(new Set());
    setLoadingPaths(new Set());
    setLoading(true);
    void loadDirectory(homePath)
      .then((result) => {
        if (!canceled) {
          setRoot(result);
        }
      })
      .catch(() => {
        if (!canceled) {
          setRoot({
            entries: [],
            message: 'The machine connector is not available right now.',
            path: homePath,
            status: 'error'
          });
        }
      })
      .finally(() => {
        if (!canceled) {
          setLoading(false);
        }
      });
    return () => {
      canceled = true;
    };
  }, [homePath, loadDirectory, refreshVersion]);

  const treeOptions = {
    expandedPaths,
    resultsByPath,
    rootEntries: root?.entries,
    showHidden
  };
  const directories = visibleTreeDirectories(root?.entries, showHidden);
  const frontier = expansionFrontier(treeOptions);

  function toggle(entry: FileSystemEntry) {
    onOpenDirectory(entry.path);
    if (expandedPaths.has(entry.path)) {
      setExpandedPaths((current) => {
        const next = new Set(current);
        next.delete(entry.path);
        return next;
      });
      return;
    }

    setExpandedPaths((current) => new Set(current).add(entry.path));
    void ensureLoaded(entry.path);
  }

  function expandOneLevel() {
    const paths = expansionFrontier(treeOptions);
    if (paths.length === 0) {
      return;
    }
    setExpandedPaths((current) => new Set([...current, ...paths]));
    void loadWithConcurrencyLimit(paths, ensureLoaded);
  }

  function collapseOneLevel() {
    setExpandedPaths(collapseDeepestExpanded(treeOptions));
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-3">
        <Text className="text-xs font-semibold text-neutral-300">~</Text>
        <div className="flex items-center gap-0.5">
          <Button
            aria-label="Collapse one folder level"
            title="Collapse one folder level"
            isDisabled={expandedPaths.size === 0}
            isIconOnly
            size="sm"
            variant="ghost"
            onPress={collapseOneLevel}
          >
            <ChevronsUp className="size-3.5" />
          </Button>
          <Button
            aria-label="Expand one folder level"
            title="Expand one folder level"
            isDisabled={frontier.length === 0 || loadingPaths.size > 0}
            isIconOnly
            size="sm"
            variant="ghost"
            onPress={expandOneLevel}
          >
            <ChevronsDown className="size-3.5" />
          </Button>
          <Button
            aria-label="Open default projects folder"
            title="Open default projects folder"
            isIconOnly
            size="sm"
            variant="ghost"
            onPress={onOpenDefault}
          >
            <Star className="size-3.5" />
          </Button>
        </div>
      </div>

      <button
        type="button"
        onClick={() => onOpenDirectory(homePath)}
        className={cn(
          'mx-2 mt-2 flex min-h-9 items-center gap-2 rounded-md px-2 text-left text-sm font-medium transition',
          isSelected(currentPath, homePath)
            ? 'bg-neutral-800 text-neutral-50'
            : 'text-neutral-300 hover:bg-neutral-900'
        )}
      >
        <FolderOpen className="size-4" />
        <span className="flex-1">~</span>
      </button>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {loading ? (
          <div className="flex items-center gap-2 px-3 py-3 text-xs text-neutral-500">
            <LoaderCircle className="size-3.5 animate-spin" />
            Loading home…
          </div>
        ) : root?.status === 'error' ? (
          <Text className="block px-3 py-3 text-xs text-rose-300/80">
            {root.message ?? 'Home cannot be loaded.'}
          </Text>
        ) : (
          directories.map((entry) => (
            <div key={entry.path} className="relative">
              <DirectoryNode
                currentPath={currentPath}
                entry={entry}
                expandedPaths={expandedPaths}
                level={0}
                loadingPaths={loadingPaths}
                onOpenContextMenu={onOpenContextMenu}
                onToggle={toggle}
                resultsByPath={resultsByPath}
                showHidden={showHidden}
              />
              {isSelected(defaultPath, entry.path) ? (
                <span className="pointer-events-none absolute top-2.5 right-2 text-[10px] font-medium text-blue-300">
                  Default
                </span>
              ) : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
