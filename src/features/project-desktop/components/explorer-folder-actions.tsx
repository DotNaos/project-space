import { useEffect, useRef, useState, type FormEvent } from 'react';
import { FolderPlus, LoaderCircle, Pencil, Trash2, X } from 'lucide-react';
import { Button, Text } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import type { FileSystemEntry } from '@/shared/project-space-api';
import { homePathLabel } from './machine-explorer-model';

export interface ExplorerContextMenuState {
  entry: FileSystemEntry;
  left: number;
  top: number;
}

export type ExplorerFolderDialogState =
  | { kind: 'create'; parentPath: string }
  | { entry: FileSystemEntry; kind: 'rename' }
  | { entries: FileSystemEntry[]; kind: 'delete' };

export function ExplorerSelectionCheckbox({
  checked,
  indeterminate = false,
  label,
  onChange
}: {
  checked: boolean;
  indeterminate?: boolean;
  label: string;
  onChange(checked: boolean): void;
}) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (ref.current) {
      ref.current.indeterminate = indeterminate;
    }
  }, [indeterminate]);

  return (
    <input
      ref={ref}
      aria-label={label}
      checked={checked}
      type="checkbox"
      onChange={(event) => onChange(event.target.checked)}
      onClick={(event) => event.stopPropagation()}
      className="size-3.5 cursor-pointer rounded border-neutral-600 bg-neutral-950 accent-neutral-100"
    />
  );
}

export function ExplorerFolderToolbar({
  allSelected,
  folderCount,
  onClearSelection,
  onDelete,
  onNewFolder,
  onRename,
  onToggleAll,
  selectedCount,
  someSelected
}: {
  allSelected: boolean;
  folderCount: number;
  onClearSelection(): void;
  onDelete(): void;
  onNewFolder(): void;
  onRename(): void;
  onToggleAll(checked: boolean): void;
  selectedCount: number;
  someSelected: boolean;
}) {
  return (
    <div className="flex min-h-11 flex-wrap items-center gap-1.5 border-b border-neutral-800 px-3 py-1.5">
      <span className="inline-flex size-8 items-center justify-center">
        <ExplorerSelectionCheckbox
          checked={allSelected}
          indeterminate={someSelected && !allSelected}
          label={allSelected ? 'Clear folder selection' : 'Select all folders'}
          onChange={onToggleAll}
        />
      </span>
      <Text className={cn('mr-1 text-xs', selectedCount > 0 ? 'text-neutral-300' : 'text-neutral-600')}>
        {selectedCount > 0 ? `${selectedCount} selected` : `${folderCount} folders`}
      </Text>
      {selectedCount > 0 ? (
        <Button size="sm" variant="ghost" onPress={onClearSelection}>
          <X className="size-3.5" />
          Clear
        </Button>
      ) : null}
      <Button size="sm" variant="ghost" onPress={onNewFolder}>
        <FolderPlus className="size-3.5" />
        New folder
      </Button>
      <Button isDisabled={selectedCount !== 1} size="sm" variant="ghost" onPress={onRename}>
        <Pencil className="size-3.5" />
        Rename
      </Button>
      <Button isDisabled={selectedCount === 0} size="sm" variant="ghost" onPress={onDelete}>
        <Trash2 className="size-3.5" />
        Delete
      </Button>
    </div>
  );
}

export function ExplorerFolderContextMenu({
  deleteEntries,
  menu,
  onClose,
  onCreate,
  onDelete,
  onRename
}: {
  deleteEntries: FileSystemEntry[];
  menu?: ExplorerContextMenuState;
  onClose(): void;
  onCreate(parentPath: string): void;
  onDelete(entries: FileSystemEntry[]): void;
  onRename(entry: FileSystemEntry): void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!menu) {
      return;
    }
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const close = () => onClose();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        return;
      }
      const items = Array.from(
        menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []
      );
      if (items.length === 0) {
        return;
      }
      event.preventDefault();
      const currentIndex = items.indexOf(document.activeElement as HTMLElement);
      const nextIndex = event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : event.key === 'ArrowDown'
            ? (currentIndex + 1) % items.length
            : (currentIndex - 1 + items.length) % items.length;
      items[nextIndex]?.focus();
    };
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', onKeyDown);
      previousFocusRef.current?.focus();
    };
  }, [menu, onClose]);

  if (!menu) {
    return null;
  }

  return (
    <div
      ref={menuRef}
      aria-label={`Actions for ${menu.entry.name}`}
      role="menu"
      style={{ left: menu.left, top: menu.top }}
      onContextMenu={(event) => event.preventDefault()}
      onPointerDown={(event) => event.stopPropagation()}
      className="fixed z-[90] min-w-48 rounded-lg border border-neutral-700 bg-neutral-950 p-1 shadow-2xl shadow-black/70"
    >
      <button
        autoFocus
        type="button"
        role="menuitem"
        onClick={() => {
          onCreate(menu.entry.path);
          onClose();
        }}
        className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-neutral-300 transition hover:bg-neutral-800 hover:text-neutral-50 focus:bg-neutral-800 focus:outline-none"
      >
        <FolderPlus className="size-3.5" />
        New folder
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onRename(menu.entry);
          onClose();
        }}
        className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-neutral-300 transition hover:bg-neutral-800 hover:text-neutral-50 focus:bg-neutral-800 focus:outline-none"
      >
        <Pencil className="size-3.5" />
        Rename
      </button>
      <div className="my-1 border-t border-neutral-800" />
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onDelete(deleteEntries);
          onClose();
        }}
        className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-red-300 transition hover:bg-red-500/10 hover:text-red-200 focus:bg-red-500/10 focus:outline-none"
      >
        <Trash2 className="size-3.5" />
        {deleteEntries.length > 1 ? `Delete ${deleteEntries.length} folders` : 'Delete'}
      </button>
    </div>
  );
}

export function ExplorerFolderDialog({
  busy,
  dialog,
  error,
  homePath,
  onCancel,
  onCreate,
  onDelete,
  onRename
}: {
  busy: boolean;
  dialog?: ExplorerFolderDialogState;
  error: string;
  homePath: string;
  onCancel(): void;
  onCreate(parentPath: string, name: string): void;
  onDelete(entries: FileSystemEntry[]): void;
  onRename(entry: FileSystemEntry, name: string): void;
}) {
  const [name, setName] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setName(dialog?.kind === 'rename' ? dialog.entry.name : '');
  }, [dialog]);

  useEffect(() => {
    if (!dialog) {
      return;
    }
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const focusFrame = window.requestAnimationFrame(() => {
      dialogRef.current?.querySelector<HTMLElement>('[data-dialog-autofocus]')?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== 'Tab') {
        return;
      }
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
        ) ?? []
      );
      if (focusable.length === 0) {
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', onKeyDown);
      previousFocusRef.current?.focus();
    };
  }, [busy, dialog, onCancel]);

  if (!dialog) {
    return null;
  }

  const isDelete = dialog.kind === 'delete';
  const title = dialog.kind === 'create'
    ? 'New folder'
    : dialog.kind === 'rename'
      ? 'Rename folder'
      : `Delete ${dialog.entries.length === 1 ? 'folder' : `${dialog.entries.length} folders`}?`;

  function submit(event: FormEvent) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName || isDelete) {
      return;
    }
    if (dialog?.kind === 'create') {
      onCreate(dialog.parentPath, trimmedName);
    } else if (dialog?.kind === 'rename') {
      onRename(dialog.entry, trimmedName);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 px-4 py-6"
      onClick={() => {
        if (!busy) {
          onCancel();
        }
      }}
    >
      <div
        ref={dialogRef}
        aria-labelledby="explorer-folder-dialog-title"
        aria-modal="true"
        role="dialog"
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-md rounded-lg border border-neutral-700 bg-neutral-950 shadow-2xl shadow-black/80"
      >
        <div className="flex items-start justify-between gap-3 border-b border-neutral-800 px-4 py-3">
          <div className="min-w-0">
            <Text id="explorer-folder-dialog-title" className="block text-sm font-semibold text-neutral-100">
              {title}
            </Text>
            <Text className="mt-1 block truncate text-xs text-neutral-500">
              {dialog.kind === 'create'
                ? homePathLabel(dialog.parentPath, homePath)
                : dialog.kind === 'rename'
                  ? homePathLabel(dialog.entry.path, homePath)
                  : 'This action permanently removes the selected folders and their contents.'}
            </Text>
          </div>
          <button
            aria-label="Close folder action"
            disabled={busy}
            type="button"
            onClick={onCancel}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-neutral-400 transition hover:bg-neutral-900 hover:text-neutral-100 disabled:opacity-50"
          >
            <X className="size-4" />
          </button>
        </div>

        {isDelete ? (
          <div className="px-4 py-4">
            <div className="max-h-48 overflow-y-auto rounded-md border border-neutral-800 bg-black/20">
              {dialog.entries.map((entry) => (
                <div key={entry.path} className="border-b border-neutral-800/70 px-3 py-2 last:border-b-0">
                  <Text className="block truncate text-xs text-neutral-300">{entry.name}</Text>
                  <Text className="block truncate font-mono text-[10px] text-neutral-600">
                    {homePathLabel(entry.path, homePath)}
                  </Text>
                </div>
              ))}
            </div>
            {error ? <Text className="mt-3 block text-xs text-red-300">{error}</Text> : null}
            <div className="mt-4 flex justify-end gap-2">
              <Button isDisabled={busy} size="sm" variant="ghost" onPress={onCancel}>Cancel</Button>
              <Button data-dialog-autofocus isDisabled={busy} size="sm" variant="danger" onPress={() => onDelete(dialog.entries)}>
                {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                Delete permanently
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="px-4 py-4">
            <label className="block text-xs font-medium text-neutral-300" htmlFor="explorer-folder-name">
              Folder name
            </label>
            <input
              autoFocus
              data-dialog-autofocus
              id="explorer-folder-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="mt-2 h-9 w-full rounded-lg border border-neutral-700 bg-black/30 px-3 text-sm text-neutral-100 outline-none transition focus:border-neutral-500 focus:ring-2 focus:ring-neutral-700/40"
            />
            {error ? <Text className="mt-2 block text-xs text-red-300">{error}</Text> : null}
            <div className="mt-4 flex justify-end gap-2">
              <Button isDisabled={busy} size="sm" variant="ghost" onPress={onCancel}>Cancel</Button>
              <Button isDisabled={busy || !name.trim()} size="sm" type="submit" variant="primary">
                {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
                {dialog.kind === 'create' ? 'Create folder' : 'Rename'}
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
