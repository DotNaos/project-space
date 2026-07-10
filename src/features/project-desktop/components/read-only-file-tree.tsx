import { useEffect, useState } from 'react';
import { ChevronRight, Folder, FolderOpen, LoaderCircle, ShieldAlert } from 'lucide-react';
import { Text } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import type { FileSystemEntry, MachineFileSystemDirectoryResult } from '@/shared/project-space-api';

interface ReadOnlyFileTreeProps {
  currentPath: string;
  defaultPath: string;
  homePath: string;
  loadDirectory(path: string): Promise<MachineFileSystemDirectoryResult>;
  onOpenDirectory(path: string): void;
  showHidden: boolean;
}

interface DirectoryNodeProps {
  currentPath: string;
  entry: FileSystemEntry;
  level: number;
  loadDirectory(path: string): Promise<MachineFileSystemDirectoryResult>;
  onOpenDirectory(path: string): void;
  showHidden: boolean;
}

function isSelected(currentPath: string, path: string) {
  return currentPath.replace(/\/+$/, '') === path.replace(/\/+$/, '');
}

function DirectoryNode({
  currentPath,
  entry,
  level,
  loadDirectory,
  onOpenDirectory,
  showHidden
}: DirectoryNodeProps) {
  const [expanded, setExpanded] = useState(false);
  const [result, setResult] = useState<MachineFileSystemDirectoryResult>();
  const [loading, setLoading] = useState(false);
  const selected = isSelected(currentPath, entry.path);

  async function toggle() {
    onOpenDirectory(entry.path);
    if (expanded) {
      setExpanded(false);
      return;
    }

    setExpanded(true);
    if (result) {
      return;
    }
    setLoading(true);
    try {
      setResult(await loadDirectory(entry.path));
    } catch {
      setResult({
        entries: [],
        message: 'The machine connector is not available right now.',
        path: entry.path,
        status: 'error'
      });
    } finally {
      setLoading(false);
    }
  }

  const directories = result?.entries.filter(
    (child) => child.kind === 'directory' && (showHidden || !child.name.startsWith('.'))
  ) ?? [];

  return (
    <div>
      <button
        aria-expanded={expanded}
        type="button"
        onClick={() => void toggle()}
        className={cn(
          'group flex min-h-9 w-full min-w-0 items-center gap-2 rounded-md pr-2 text-left text-sm transition',
          selected
            ? 'bg-neutral-800 text-neutral-50'
            : 'text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100'
        )}
        style={{ paddingLeft: `${level * 15 + 10}px` }}
      >
        <ChevronRight
          className={cn('size-3.5 shrink-0 text-neutral-600 transition-transform', expanded && 'rotate-90')}
        />
        {expanded ? (
          <FolderOpen className="size-4 shrink-0 text-neutral-300" />
        ) : (
          <Folder className="size-4 shrink-0 text-neutral-500 group-hover:text-neutral-300" />
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
                level={level + 1}
                loadDirectory={loadDirectory}
                onOpenDirectory={onOpenDirectory}
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
  onOpenDirectory,
  showHidden
}: ReadOnlyFileTreeProps) {
  const [root, setRoot] = useState<MachineFileSystemDirectoryResult>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let canceled = false;
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
  }, [homePath, loadDirectory]);

  const directories = root?.entries.filter(
    (entry) => entry.kind === 'directory' && (showHidden || !entry.name.startsWith('.'))
  ) ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
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
                level={0}
                loadDirectory={loadDirectory}
                onOpenDirectory={onOpenDirectory}
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
