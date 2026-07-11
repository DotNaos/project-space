import { useCallback, useEffect, useMemo, useState } from 'react';
import { FileIcon } from '@dotnaos/react-ui';
import {
  ArrowLeft,
  ArrowRight,
  Eye,
  EyeOff,
  Folder,
  FolderKanban,
  Home,
  Info,
  LoaderCircle,
  RotateCw,
  Star
} from 'lucide-react';
import { projectSpaceClient } from '@/api/project-space-client';
import { Button, Surface, Text } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import type { FileSystemEntry, MachineFileSystemDirectoryResult, MachineFileSystemFileResult, MachineRecord } from '@/shared/project-space-api';
import { formatExplorerFileSize, formatExplorerModifiedDate } from './explorer-file-format';
import {
  ExplorerFolderContextMenu,
  ExplorerFolderDialog,
  ExplorerFolderToolbar,
  ExplorerSelectionCheckbox,
  type ExplorerContextMenuState,
  type ExplorerFolderDialogState
} from './explorer-folder-actions';
import { ExplorerAddressBar } from './explorer-path-search';
import {
  homePathLabel,
  isHiddenFileSystemName
} from './machine-explorer-model';
import { MachineExplorerFileViewer } from './machine-explorer-file-viewer';
import { ReadOnlyFileTree } from './read-only-file-tree';

function pathIsAtOrBelow(path: string, ancestor: string) {
  const normalizedPath = path.replace(/\/+$/, '');
  const normalizedAncestor = ancestor.replace(/\/+$/, '');
  return normalizedPath === normalizedAncestor || normalizedPath.startsWith(`${normalizedAncestor}/`);
}

function replacePathPrefix(path: string, previousPrefix: string, nextPrefix: string) {
  return pathIsAtOrBelow(path, previousPrefix)
    ? `${nextPrefix}${path.slice(previousPrefix.replace(/\/+$/, '').length)}`
    : path;
}

function parentPath(path: string) {
  const normalized = path.replace(/\/+$/, '');
  const separator = normalized.lastIndexOf('/');
  return separator <= 0 ? '/' : normalized.slice(0, separator);
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
  const [showHidden, setShowHidden] = useState(true);
  const [selectedFolderPaths, setSelectedFolderPaths] = useState<Set<string>>(() => new Set());
  const [contextMenu, setContextMenu] = useState<ExplorerContextMenuState>();
  const [folderDialog, setFolderDialog] = useState<ExplorerFolderDialogState>();
  const [folderActionBusy, setFolderActionBusy] = useState(false);
  const [folderActionError, setFolderActionError] = useState('');

  const loadDirectory = useCallback(
    (path: string) => projectSpaceClient.readMachineDirectory({ machineId: machine.id, path }),
    [machine.id]
  );
  const displayedEntries = useMemo(
    () =>
      directory?.entries.filter(
        (entry) => showHidden || !isHiddenFileSystemName(entry.name)
      ) ?? [],
    [directory?.entries, showHidden]
  );
  const displayedFolders = useMemo(
    () => displayedEntries.filter((entry) => entry.kind === 'directory'),
    [displayedEntries]
  );
  const selectedFolders = useMemo(
    () => displayedFolders.filter((entry) => selectedFolderPaths.has(entry.path)),
    [displayedFolders, selectedFolderPaths]
  );
  const allFoldersSelected = displayedFolders.length > 0 && selectedFolders.length === displayedFolders.length;
  const contextDeleteEntries = contextMenu && selectedFolderPaths.has(contextMenu.entry.path) && selectedFolders.length > 0
    ? selectedFolders
    : contextMenu
      ? [contextMenu.entry]
      : [];

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
  const closeContextMenu = useCallback(() => setContextMenu(undefined), []);
  const closeFolderDialog = useCallback(() => {
    if (!folderActionBusy) {
      setFolderDialog(undefined);
      setFolderActionError('');
    }
  }, [folderActionBusy]);

  useEffect(() => {
    setSelectedFolderPaths(new Set());
    setContextMenu(undefined);
  }, [currentPath, showHidden]);

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
    setDirectory(undefined);
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

  function setFolderSelected(path: string, selected: boolean) {
    setSelectedFolderPaths((current) => {
      const next = new Set(current);
      if (selected) {
        next.add(path);
      } else {
        next.delete(path);
      }
      return next;
    });
  }

  function openFolderContextMenu(entry: FileSystemEntry, clientX: number, clientY: number) {
    if (entry.kind !== 'directory') {
      return;
    }
    const isDisplayedFolder = displayedFolders.some((folder) => folder.path === entry.path);
    if (!isDisplayedFolder) {
      setSelectedFolderPaths(new Set());
    } else if (!selectedFolderPaths.has(entry.path)) {
      setSelectedFolderPaths(new Set([entry.path]));
    }
    const menuWidth = 208;
    const menuHeight = 150;
    setContextMenu({
      entry,
      left: Math.max(8, Math.min(clientX, window.innerWidth - menuWidth - 8)),
      top: Math.max(8, Math.min(clientY, window.innerHeight - menuHeight - 8))
    });
  }

  function openCreateDialog(parentPath: string) {
    setFolderActionError('');
    setFolderDialog({ kind: 'create', parentPath });
  }

  function openRenameDialog(entry: FileSystemEntry) {
    setFolderActionError('');
    setFolderDialog({ entry, kind: 'rename' });
  }

  function openDeleteDialog(entries: FileSystemEntry[]) {
    if (entries.length === 0) {
      return;
    }
    setFolderActionError('');
    setFolderDialog({ entries, kind: 'delete' });
  }

  async function createFolder(parentPath: string, name: string) {
    setFolderActionBusy(true);
    setFolderActionError('');
    try {
      const result = await projectSpaceClient.createMachineDirectory({
        machineId: machine.id,
        name,
        parentPath
      });
      if (result.status === 'error') {
        setFolderActionError(result.message ?? 'The folder could not be created.');
        return;
      }
      setFolderDialog(undefined);
      setRefreshVersion((value) => value + 1);
    } catch (error) {
      setFolderActionError(error instanceof Error ? error.message : 'The folder could not be created.');
    } finally {
      setFolderActionBusy(false);
    }
  }

  async function renameFolder(entry: FileSystemEntry, name: string) {
    setFolderActionBusy(true);
    setFolderActionError('');
    try {
      const result = await projectSpaceClient.renameMachineDirectory({
        machineId: machine.id,
        name,
        path: entry.path
      });
      if (result.status === 'error') {
        setFolderActionError(result.message ?? 'The folder could not be renamed.');
        return;
      }
      const renamedPath = result.affectedPaths[0];
      if (renamedPath && pathIsAtOrBelow(currentPath, entry.path)) {
        const nextCurrentPath = replacePathPrefix(currentPath, entry.path, renamedPath);
        setHistory((current) => current.map((path) => replacePathPrefix(path, entry.path, renamedPath)));
        setSelectedFile(undefined);
        setCurrentPath(nextCurrentPath);
      }
      setFolderDialog(undefined);
      setSelectedFolderPaths(new Set());
      setRefreshVersion((value) => value + 1);
    } catch (error) {
      setFolderActionError(error instanceof Error ? error.message : 'The folder could not be renamed.');
    } finally {
      setFolderActionBusy(false);
    }
  }

  async function deleteFolders(entries: FileSystemEntry[]) {
    setFolderActionBusy(true);
    setFolderActionError('');
    try {
      const result = await projectSpaceClient.deleteMachineDirectories({
        machineId: machine.id,
        paths: entries.map((entry) => entry.path)
      });
      const deletedPaths = result.affectedPaths;
      let nextCurrentPath = currentPath;
      while (deletedPaths.some((path) => pathIsAtOrBelow(nextCurrentPath, path))) {
        nextCurrentPath = parentPath(nextCurrentPath);
      }
      if (nextCurrentPath !== currentPath) {
        openDirectory(nextCurrentPath);
      }
      if (result.status === 'error') {
        setFolderActionError(result.message ?? 'The selected folders could not be deleted.');
        if (deletedPaths.length > 0) {
          const deleted = new Set(deletedPaths);
          const remainingEntries = entries.filter((entry) => !deleted.has(entry.path));
          setFolderDialog(remainingEntries.length > 0
            ? { entries: remainingEntries, kind: 'delete' }
            : undefined);
          setSelectedFolderPaths(new Set(remainingEntries.map((entry) => entry.path)));
          setRefreshVersion((value) => value + 1);
        }
        return;
      }
      setFolderDialog(undefined);
      setSelectedFolderPaths(new Set());
      setRefreshVersion((value) => value + 1);
    } catch (error) {
      setFolderActionError(error instanceof Error ? error.message : 'The selected folders could not be deleted.');
    } finally {
      setFolderActionBusy(false);
    }
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
        <ReadOnlyFileTree
          currentPath={currentPath}
          defaultPath={defaultPath}
          homePath={homePath}
          loadDirectory={loadDirectory}
          onOpenDefault={() => openDirectory(defaultPath)}
          onOpenContextMenu={openFolderContextMenu}
          onOpenDirectory={openDirectory}
          refreshVersion={refreshVersion}
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
          <ExplorerAddressBar
            currentDirectory={directory}
            currentPath={currentPath}
            displayPath={selectedFile?.path ?? currentPath}
            displayPathIsFile={Boolean(selectedFile)}
            homePath={homePath}
            loadDirectory={loadDirectory}
            onOpenBreadcrumb={openDirectory}
            onOpenEntry={(entry) => void openEntry(entry)}
            onOpenPath={openDirectory}
            onValueChange={setPathInput}
            showHidden={showHidden}
            value={pathInput}
          />
          <Button size="sm" variant="outline" onPress={() => openDirectory(defaultPath)}>
            <Star className="size-3.5" />
            ~/projects
            <span className="text-blue-300">Default</span>
          </Button>
          <Button
            aria-label={showHidden ? 'Hide hidden files' : 'Show hidden files'}
            aria-pressed={showHidden}
            title={showHidden ? 'Hide hidden files' : 'Show hidden files'}
            size="sm"
            variant="outline"
            onPress={() => setShowHidden((value) => !value)}
          >
            {showHidden ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            {showHidden ? 'Hide hidden files' : 'Show hidden files'}
          </Button>
        </div>

        {!selectedFile ? (
          <ExplorerFolderToolbar
            allSelected={allFoldersSelected}
            folderCount={displayedFolders.length}
            selectedCount={selectedFolders.length}
            someSelected={selectedFolders.length > 0}
            onClearSelection={() => setSelectedFolderPaths(new Set())}
            onDelete={() => openDeleteDialog(selectedFolders)}
            onNewFolder={() => openCreateDialog(currentPath)}
            onRename={() => {
              const selected = selectedFolders[0];
              if (selected) {
                openRenameDialog(selected);
              }
            }}
            onToggleAll={(checked) => {
              setSelectedFolderPaths(checked
                ? new Set(displayedFolders.map((entry) => entry.path))
                : new Set());
            }}
          />
        ) : null}

        {selectedFile ? (
          <MachineExplorerFileViewer
            file={selectedFile}
            homePath={homePath}
            onBack={() => {
              setSelectedFile(undefined);
              setPathInput(homePathLabel(currentPath, homePath));
            }}
          />
        ) : loading && !directory ? (
          <div className="flex flex-1 items-center justify-center text-sm text-neutral-500">
            <LoaderCircle className="mr-2 size-4 animate-spin" />
            Loading folder…
          </div>
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
            <table className="w-full min-w-[42rem] border-collapse text-left text-sm">
              <thead className="sticky top-0 z-10 bg-neutral-950/95 text-xs text-neutral-500 backdrop-blur">
                <tr className="border-b border-neutral-800">
                  <th className="w-10 px-3 py-3 text-center font-medium">
                    <ExplorerSelectionCheckbox
                      checked={allFoldersSelected}
                      indeterminate={selectedFolders.length > 0 && !allFoldersSelected}
                      label={allFoldersSelected ? 'Clear folder selection' : 'Select all folders'}
                      onChange={(checked) => {
                        setSelectedFolderPaths(checked
                          ? new Set(displayedFolders.map((entry) => entry.path))
                          : new Set());
                      }}
                    />
                  </th>
                  <th className="px-4 py-3 font-medium">Name</th>
                  <th className="w-28 px-4 py-3 font-medium">Project</th>
                  <th className="w-28 px-4 py-3 font-medium">Type</th>
                  <th className="w-48 px-4 py-3 font-medium">Modified</th>
                  <th className="w-24 px-4 py-3 text-right font-medium">Size</th>
                </tr>
              </thead>
              <tbody>
                {displayedEntries.map((entry) => {
                  const hidden = isHiddenFileSystemName(entry.name);
                  const selected = selectedFolderPaths.has(entry.path);
                  return (
                    <tr
                      aria-selected={entry.kind === 'directory' ? selected : undefined}
                      key={entry.path}
                      tabIndex={0}
                      onClick={(event) => {
                        if (entry.kind === 'directory' && (event.metaKey || event.ctrlKey)) {
                          setFolderSelected(entry.path, !selected);
                          return;
                        }
                        void openEntry(entry);
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        openFolderContextMenu(entry, event.clientX, event.clientY);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                          event.preventDefault();
                          const bounds = event.currentTarget.getBoundingClientRect();
                          openFolderContextMenu(entry, bounds.left + 36, bounds.top + bounds.height / 2);
                        } else if (event.key === 'Enter') {
                          void openEntry(entry);
                        } else if (entry.kind === 'directory' && event.key === ' ') {
                          event.preventDefault();
                          setFolderSelected(entry.path, !selected);
                        }
                      }}
                      className={cn(
                        'cursor-pointer border-b border-neutral-800/70 transition hover:bg-neutral-900/70 focus:bg-neutral-900 focus:outline-none',
                        hidden ? 'text-neutral-400' : 'text-neutral-300',
                        selected && 'bg-neutral-800/70'
                      )}
                    >
                      <td className="px-3 py-3 text-center">
                        {entry.kind === 'directory' ? (
                          <ExplorerSelectionCheckbox
                            checked={selected}
                            label={`Select ${entry.name}`}
                            onChange={(checked) => setFolderSelected(entry.path, checked)}
                          />
                        ) : null}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex min-w-0 items-center gap-3">
                          {entry.kind === 'directory' ? (
                            <Folder
                              className={cn(
                                'size-4 shrink-0',
                                hidden ? 'text-neutral-600' : 'text-neutral-400'
                              )}
                            />
                          ) : (
                            <FileIcon
                              filename={entry.name}
                              grayscale
                              size={17}
                              className={cn('shrink-0', hidden ? 'opacity-50' : 'opacity-80')}
                            />
                          )}
                          <span className="truncate">{entry.name}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {entry.isProject ? (
                          <span className="inline-flex items-center gap-1 rounded-md bg-blue-400/10 px-1.5 py-0.5 font-medium text-blue-300">
                            <FolderKanban className="size-3" />
                            Project
                          </span>
                        ) : (
                          <span className="text-neutral-700">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-neutral-500">
                        {entry.kind === 'directory' ? 'Folder' : 'File'}
                      </td>
                      <td className="px-4 py-3 text-xs text-neutral-500">{formatExplorerModifiedDate(entry.modifiedAt)}</td>
                      <td className="px-4 py-3 text-right font-mono text-xs text-neutral-600">
                        {entry.kind === 'file' ? formatExplorerFileSize(entry.sizeBytes) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex items-center justify-between border-t border-neutral-800 px-4 py-2 text-[11px] text-neutral-600">
          <span>{displayedEntries.length} items</span>
          <span>Files are read-only</span>
        </div>
      </div>

      <ExplorerFolderContextMenu
        deleteEntries={contextDeleteEntries}
        menu={contextMenu}
        onClose={closeContextMenu}
        onCreate={openCreateDialog}
        onDelete={openDeleteDialog}
        onRename={openRenameDialog}
      />
      <ExplorerFolderDialog
        busy={folderActionBusy}
        dialog={folderDialog}
        error={folderActionError}
        homePath={homePath}
        onCancel={closeFolderDialog}
        onCreate={(parentPath, name) => void createFolder(parentPath, name)}
        onDelete={(entries) => void deleteFolders(entries)}
        onRename={(entry, name) => void renameFolder(entry, name)}
      />
    </Surface>
  );
}
