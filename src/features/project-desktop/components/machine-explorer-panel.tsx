import { useCallback, useEffect, useMemo, useState } from 'react';
import { FileIcon } from '@dotnaos/react-ui';
import {
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  Eye,
  EyeOff,
  FileText,
  Folder,
  Home,
  Info,
  LoaderCircle,
  LockKeyhole,
  RotateCw,
  Star
} from 'lucide-react';
import { projectSpaceClient } from '@/api/project-space-client';
import { Button, Surface, Text } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import type {
  FileSystemEntry,
  MachineFileSystemDirectoryResult,
  MachineFileSystemFileResult,
  MachineRecord
} from '@/shared/project-space-api';
import { ReadOnlyFileTree } from './read-only-file-tree';

function homePathLabel(path: string, homePath: string) {
  if (path === homePath) {
    return '~';
  }
  return path.startsWith(`${homePath}/`) ? `~${path.slice(homePath.length)}` : path;
}

function enteredPath(value: string, homePath: string) {
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

function formatBytes(size?: number) {
  if (size === undefined) {
    return '—';
  }
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${Math.max(1, Math.round(size / 1024))} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatModified(value?: string) {
  if (!value) {
    return '—';
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium'
  }).format(new Date(value));
}

function FileViewer({
  file,
  homePath,
  onBack
}: {
  file: MachineFileSystemFileResult;
  homePath: string;
  onBack(): void;
}) {
  const lines = useMemo(() => (file.content ?? '').split('\n'), [file.content]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-800 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <Button size="sm" variant="ghost" onPress={onBack}>
            <ArrowLeft className="size-4" />
            Back
          </Button>
          <FileText className="size-4 shrink-0 text-neutral-400" />
          <div className="min-w-0">
            <Text className="block truncate text-sm font-semibold text-neutral-100">{file.name}</Text>
            <Text className="block truncate text-xs text-neutral-500">
              {formatBytes(file.sizeBytes)} · {formatModified(file.modifiedAt)}
            </Text>
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          onPress={() => void navigator.clipboard?.writeText(homePathLabel(file.path, homePath))}
        >
          Copy path
        </Button>
      </div>

      {file.status === 'error' ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center">
          <div className="max-w-md">
            <Info className="mx-auto mb-3 size-5 text-amber-300" />
            <Text className="block text-sm font-medium text-neutral-200">File cannot be displayed</Text>
            <Text className="mt-1 block text-xs text-neutral-500">
              {file.message ?? 'This file is unavailable.'}
            </Text>
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto bg-black/25 font-mono text-[12px] leading-5">
          <div className="min-w-max py-3">
            {lines.map((line, index) => (
              <div key={`${index}-${line.slice(0, 24)}`} className="flex min-h-5">
                <span className="w-14 shrink-0 select-none border-r border-neutral-800 pr-3 text-right text-neutral-700">
                  {index + 1}
                </span>
                <span className="whitespace-pre px-4 text-neutral-300">{line || ' '}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between border-t border-neutral-800 px-4 py-2 text-xs text-neutral-500">
        <span>{file.truncated ? 'Preview truncated at 5,000 lines.' : 'File contents are read-only.'}</span>
        <span>{lines.length} lines</span>
      </div>
    </div>
  );
}

export function MachineExplorerPanel({ machine }: { machine: MachineRecord }) {
  const [homePath, setHomePath] = useState('');
  const [defaultPath, setDefaultPath] = useState('');
  const [currentPath, setCurrentPath] = useState('');
  const [pathInput, setPathInput] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [directory, setDirectory] = useState<MachineFileSystemDirectoryResult>();
  const [selectedFile, setSelectedFile] = useState<MachineFileSystemFileResult>();
  const [loading, setLoading] = useState(true);
  const [rootMessage, setRootMessage] = useState('');
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [showHidden, setShowHidden] = useState(false);

  const loadDirectory = useCallback(
    (path: string) => projectSpaceClient.readMachineDirectory({ machineId: machine.id, path }),
    [machine.id]
  );
  const displayedEntries = useMemo(
    () => directory?.entries.filter((entry) => showHidden || !entry.name.startsWith('.')) ?? [],
    [directory?.entries, showHidden]
  );

  const openDirectory = useCallback((path: string, recordHistory = true) => {
    setSelectedFile(undefined);
    setCurrentPath(path);
    if (recordHistory) {
      setHistory((current) => {
        const next = [...current.slice(0, historyIndex + 1), path];
        setHistoryIndex(next.length - 1);
        return next;
      });
    }
  }, [historyIndex]);

  useEffect(() => {
    let canceled = false;
    setLoading(true);
    setRootMessage('');
    void projectSpaceClient
      .getMachineFileSystemRoot({ machineId: machine.id })
      .then((root) => {
        if (canceled) {
          return;
        }
        if (root.status === 'error') {
          setRootMessage(root.message ?? 'Explorer is unavailable.');
          setLoading(false);
          return;
        }
        setHomePath(root.homePath);
        setDefaultPath(root.defaultPath);
        setHistory([root.defaultPath]);
        setHistoryIndex(0);
        setCurrentPath(root.defaultPath);
      })
      .catch(() => {
        if (!canceled) {
          setRootMessage('The machine connector is not available right now.');
          setLoading(false);
        }
      });
    return () => {
      canceled = true;
    };
  }, [machine.id]);

  useEffect(() => {
    if (!currentPath || !homePath) {
      return;
    }
    let canceled = false;
    setLoading(true);
    setPathInput(homePathLabel(currentPath, homePath));
    void loadDirectory(currentPath)
      .then((result) => {
        if (!canceled) {
          setDirectory(result);
          setCurrentPath(result.path || currentPath);
          setPathInput(homePathLabel(result.path || currentPath, homePath));
          setLoading(false);
        }
      })
      .catch(() => {
        if (!canceled) {
          setDirectory({
            entries: [],
            message: 'The machine connector is not available right now.',
            path: currentPath,
            status: 'error'
          });
          setLoading(false);
        }
      });
    return () => {
      canceled = true;
    };
  }, [currentPath, homePath, loadDirectory, refreshVersion]);

  async function openEntry(entry: FileSystemEntry) {
    if (entry.kind === 'directory') {
      openDirectory(entry.path);
      return;
    }
    setLoading(true);
    try {
      setSelectedFile(await projectSpaceClient.readMachineFile({
        machineId: machine.id,
        path: entry.path
      }));
    } catch {
      setSelectedFile({
        message: 'The machine connector is not available right now.',
        name: entry.name,
        path: entry.path,
        status: 'error'
      });
    }
    setLoading(false);
  }

  function moveHistory(offset: number) {
    const nextIndex = historyIndex + offset;
    const nextPath = history[nextIndex];
    if (!nextPath) {
      return;
    }
    setHistoryIndex(nextIndex);
    openDirectory(nextPath, false);
  }

  if (rootMessage) {
    return (
      <Surface variant="tertiary" className="flex min-h-[28rem] items-center justify-center rounded-lg p-8 text-center">
        <div className="max-w-md">
          <Info className="mx-auto mb-3 size-5 text-amber-300" />
          <Text className="block text-sm font-medium text-neutral-200">Explorer unavailable</Text>
          <Text className="mt-1 block text-xs text-neutral-500">{rootMessage}</Text>
        </div>
      </Surface>
    );
  }

  if (!homePath) {
    return (
      <div className="flex min-h-[28rem] items-center justify-center text-sm text-neutral-500">
        <LoaderCircle className="mr-2 size-4 animate-spin" />
        Loading Explorer…
      </div>
    );
  }

  return (
    <Surface
      variant="tertiary"
      className="flex h-[calc(100vh-15rem)] min-h-[28rem] shrink-0 overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950/45"
    >
      <aside className="flex w-64 shrink-0 flex-col border-r border-neutral-800">
        <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-3">
          <Text className="text-xs font-semibold text-neutral-300">~</Text>
          <Button
            aria-label="Open default projects folder"
            isIconOnly
            size="sm"
            variant="ghost"
            onPress={() => openDirectory(defaultPath)}
          >
            <Star className="size-3.5" />
          </Button>
        </div>
        <ReadOnlyFileTree
          currentPath={currentPath}
          defaultPath={defaultPath}
          homePath={homePath}
          loadDirectory={loadDirectory}
          onOpenDirectory={openDirectory}
          showHidden={showHidden}
        />
        <div className="flex items-center gap-2 border-t border-neutral-800 px-3 py-2 text-[11px] text-neutral-600">
          <Info className="size-3.5" />
          Home directory only
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-neutral-800 p-3">
          <Button aria-label="Home" isIconOnly size="sm" variant="ghost" onPress={() => openDirectory(homePath)}>
            <Home className="size-4" />
          </Button>
          <Button aria-label="Back" isDisabled={historyIndex <= 0} isIconOnly size="sm" variant="ghost" onPress={() => moveHistory(-1)}>
            <ArrowLeft className="size-4" />
          </Button>
          <Button aria-label="Forward" isDisabled={historyIndex >= history.length - 1} isIconOnly size="sm" variant="ghost" onPress={() => moveHistory(1)}>
            <ArrowRight className="size-4" />
          </Button>
          <form
            className="flex min-w-48 flex-1 gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              openDirectory(enteredPath(pathInput, homePath));
            }}
          >
            <input
              aria-label="Explorer path"
              value={pathInput}
              onChange={(event) => setPathInput(event.target.value)}
              className="h-8 w-full rounded-lg border border-neutral-700 bg-black/30 px-3 font-mono text-xs text-neutral-200 outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-700/40"
            />
            <Button aria-label="Open path" isIconOnly size="sm" type="submit" variant="secondary">
              <ArrowRight className="size-3.5" />
            </Button>
          </form>
          <Button size="sm" variant="outline" onPress={() => openDirectory(defaultPath)}>
            <Star className="size-3.5" />
            ~/projects
            <span className="text-blue-300">Default</span>
          </Button>
          <Button
            aria-label={showHidden ? 'Hide hidden files' : 'Show hidden files'}
            title={showHidden ? 'Hide hidden files' : 'Show hidden files'}
            isIconOnly
            size="sm"
            variant="ghost"
            onPress={() => setShowHidden((value) => !value)}
          >
            {showHidden ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          </Button>
        </div>

        <div className="flex items-center justify-between gap-3 border-b border-neutral-800 px-4 py-3">
          <div className="flex min-w-0 items-center gap-1 text-sm text-neutral-300">
            {homePathLabel(selectedFile?.path ?? currentPath, homePath)
              .split('/')
              .map((part, index) => (
                <span key={`${part}-${index}`} className="flex min-w-0 items-center gap-1">
                  {index > 0 ? <ChevronRight className="size-3.5 shrink-0 text-neutral-700" /> : null}
                  <span className="truncate">{part}</span>
                </span>
              ))}
          </div>
          <div className="flex shrink-0 items-center gap-2 text-xs text-neutral-500">
            {loading ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
            <LockKeyhole className="size-3.5" />
            Read-only
          </div>
        </div>

        {selectedFile ? (
          <FileViewer file={selectedFile} homePath={homePath} onBack={() => setSelectedFile(undefined)} />
        ) : directory?.status === 'error' ? (
          <div className="flex flex-1 items-center justify-center px-6 text-center">
            <div className="max-w-md">
              <Info className="mx-auto mb-3 size-5 text-rose-300" />
              <Text className="block text-sm font-medium text-neutral-200">Folder cannot be opened</Text>
              <Text className="mt-1 block text-xs text-neutral-500">{directory.message}</Text>
              <Button className="mt-4" size="sm" variant="outline" onPress={() => setRefreshVersion((value) => value + 1)}>
                <RotateCw className="size-3.5" />
                Retry
              </Button>
            </div>
          </div>
        ) : displayedEntries.length === 0 && !loading ? (
          <div className="flex flex-1 items-center justify-center text-sm text-neutral-500">This folder is empty.</div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full min-w-[34rem] border-collapse text-left text-sm">
              <thead className="sticky top-0 z-10 bg-neutral-950/95 text-xs text-neutral-500 backdrop-blur">
                <tr className="border-b border-neutral-800">
                  <th className="px-4 py-3 font-medium">Name</th>
                  <th className="w-28 px-4 py-3 font-medium">Type</th>
                  <th className="w-48 px-4 py-3 font-medium">Modified</th>
                  <th className="w-24 px-4 py-3 text-right font-medium">Size</th>
                </tr>
              </thead>
              <tbody>
                {displayedEntries.map((entry) => (
                  <tr
                    key={entry.path}
                    tabIndex={0}
                    onClick={() => void openEntry(entry)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        void openEntry(entry);
                      }
                    }}
                    className={cn(
                      'cursor-pointer border-b border-neutral-800/70 text-neutral-300 transition hover:bg-neutral-900/70 focus:bg-neutral-900 focus:outline-none'
                    )}
                  >
                    <td className="px-4 py-3">
                      <div className="flex min-w-0 items-center gap-3">
                        {entry.kind === 'directory' ? (
                          <Folder className="size-4 shrink-0 text-neutral-400" />
                        ) : (
                          <FileIcon filename={entry.name} grayscale size={17} className="shrink-0 opacity-80" />
                        )}
                        <span className="truncate">{entry.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-neutral-500">
                      {entry.kind === 'directory' ? 'Folder' : 'File'}
                    </td>
                    <td className="px-4 py-3 text-xs text-neutral-500">{formatModified(entry.modifiedAt)}</td>
                    <td className="px-4 py-3 text-right font-mono text-xs text-neutral-600">
                      {entry.kind === 'file' ? formatBytes(entry.sizeBytes) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex items-center justify-between border-t border-neutral-800 px-4 py-2 text-[11px] text-neutral-600">
          <span>{displayedEntries.length} items</span>
          <span className="flex items-center gap-1.5"><LockKeyhole className="size-3" /> Read-only</span>
        </div>
      </div>
    </Surface>
  );
}
