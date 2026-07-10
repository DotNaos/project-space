import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { FileIcon } from '@dotnaos/react-ui';
import { ArrowRight, Folder, FolderKanban, LoaderCircle, Search } from 'lucide-react';
import { Button } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import type {
  FileSystemEntry,
  MachineFileSystemDirectoryResult
} from '@/shared/project-space-api';
import {
  completedPathValue,
  enteredPath,
  explorerPathQuery,
  explorerPathSuggestions,
  homePathLabel
} from './machine-explorer-model';

interface ExplorerPathSearchProps {
  currentDirectory?: MachineFileSystemDirectoryResult;
  currentPath: string;
  homePath: string;
  loadDirectory(path: string): Promise<MachineFileSystemDirectoryResult>;
  onOpenEntry(entry: FileSystemEntry): void;
  onOpenPath(path: string): void;
  onValueChange(value: string): void;
  showHidden: boolean;
  value: string;
}

export function ExplorerPathSearch({
  currentDirectory,
  currentPath,
  homePath,
  loadDirectory,
  onOpenEntry,
  onOpenPath,
  onValueChange,
  showHidden,
  value
}: ExplorerPathSearchProps) {
  const listBoxId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const requestVersion = useRef(0);
  const cache = useRef(new Map<string, MachineFileSystemDirectoryResult>());
  const [activeIndex, setActiveIndex] = useState(0);
  const [focused, setFocused] = useState(false);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<FileSystemEntry[]>([]);

  useEffect(() => {
    if (currentDirectory?.status === 'success') {
      cache.current.set(currentDirectory.path, currentDirectory);
    }
  }, [currentDirectory]);

  useEffect(() => {
    if (!focused) {
      return;
    }

    const version = ++requestVersion.current;
    const query = explorerPathQuery(value, homePath, currentPath);
    const cached = cache.current.get(query.directoryPath);

    function apply(result: MachineFileSystemDirectoryResult) {
      if (version !== requestVersion.current) {
        return;
      }
      const next = explorerPathSuggestions({
        nameQuery: query.nameQuery,
        result,
        showHidden
      });
      setSuggestions(next);
      setActiveIndex(0);
      setLoading(false);
      setOpen(true);
    }

    if (cached) {
      apply(cached);
      return;
    }

    setLoading(true);
    setOpen(true);
    const timeout = window.setTimeout(() => {
      void loadDirectory(query.directoryPath)
        .then((result) => {
          if (result.status === 'success') {
            cache.current.set(query.directoryPath, result);
          }
          apply(result);
        })
        .catch(() => {
          if (version === requestVersion.current) {
            setSuggestions([]);
            setLoading(false);
            setOpen(true);
          }
        });
    }, 150);

    return () => window.clearTimeout(timeout);
  }, [currentPath, focused, homePath, loadDirectory, showHidden, value]);

  function choose(entry: FileSystemEntry) {
    requestVersion.current += 1;
    inputRef.current?.blur();
    setFocused(false);
    setLoading(false);
    setOpen(false);
    onValueChange(homePathLabel(entry.path, homePath));
    onOpenEntry(entry);
  }

  function complete(entry: FileSystemEntry) {
    requestVersion.current += 1;
    setSuggestions([]);
    setActiveIndex(0);
    setLoading(true);
    onValueChange(completedPathValue(entry, homePath));
    setOpen(true);
  }

  function openTypedPath() {
    requestVersion.current += 1;
    inputRef.current?.blur();
    setFocused(false);
    setLoading(false);
    setOpen(false);
    onOpenPath(enteredPath(value, homePath));
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const active = open ? suggestions[activeIndex] : undefined;
    if (active) {
      choose(active);
      return;
    }
    openTypedPath();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' && suggestions.length > 0) {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((index) => (index + 1) % suggestions.length);
      return;
    }
    if (event.key === 'ArrowUp' && suggestions.length > 0) {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((index) => (index - 1 + suggestions.length) % suggestions.length);
      return;
    }
    if (event.key === 'Tab' && open && suggestions[activeIndex]) {
      event.preventDefault();
      complete(suggestions[activeIndex]);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const active = open ? suggestions[activeIndex] : undefined;
      if (active) {
        choose(active);
      } else {
        openTypedPath();
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      requestVersion.current += 1;
      setLoading(false);
      setOpen(false);
    }
  }

  const showPopover = focused && open;

  return (
    <form className="flex min-w-48 flex-1 gap-1" onSubmit={handleSubmit}>
      <div className="relative min-w-0 flex-1">
        <Search className="pointer-events-none absolute top-2 left-3 z-10 size-3.5 text-neutral-600" />
        <input
          aria-activedescendant={
            showPopover && suggestions[activeIndex]
              ? `${listBoxId}-option-${activeIndex}`
              : undefined
          }
          aria-autocomplete="list"
          aria-controls={listBoxId}
          aria-expanded={showPopover}
          aria-label="Explorer path search"
          autoComplete="off"
          ref={inputRef}
          role="combobox"
          spellCheck={false}
          value={value}
          onBlur={() => {
            requestVersion.current += 1;
            setFocused(false);
            setLoading(false);
            setOpen(false);
          }}
          onChange={(event) => {
            requestVersion.current += 1;
            setSuggestions([]);
            setActiveIndex(0);
            setLoading(true);
            setOpen(true);
            onValueChange(event.target.value);
          }}
          onFocus={() => {
            setFocused(true);
            setOpen(true);
          }}
          onKeyDown={handleKeyDown}
          className="h-8 w-full rounded-lg border border-neutral-700 bg-black/30 pr-8 pl-9 font-mono text-xs text-neutral-200 outline-none transition placeholder:text-neutral-700 focus:border-neutral-500 focus:ring-2 focus:ring-neutral-700/40"
          placeholder="Search paths in your home folder"
        />
        {loading ? (
          <LoaderCircle className="pointer-events-none absolute top-2 right-3 size-3.5 animate-spin text-neutral-600" />
        ) : null}

        {showPopover ? (
          <div className="absolute top-full right-0 left-0 z-40 mt-1 overflow-hidden rounded-lg border border-neutral-700 bg-neutral-950 shadow-2xl shadow-black/60">
            <div id={listBoxId} role="listbox" aria-label="Path suggestions" className="max-h-80 overflow-y-auto p-1">
              {suggestions.length > 0 ? (
                suggestions.map((entry, index) => {
                  return (
                    <div
                      aria-selected={index === activeIndex}
                      id={`${listBoxId}-option-${index}`}
                      key={entry.path}
                      role="option"
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => choose(entry)}
                      className={cn(
                        'flex cursor-pointer items-center gap-3 rounded-md px-2.5 py-2 text-left',
                        index === activeIndex
                          ? 'bg-neutral-800 text-neutral-50'
                          : 'text-neutral-300 hover:bg-neutral-900'
                      )}
                    >
                      {entry.kind === 'directory' ? (
                        <Folder className="size-4 shrink-0 text-neutral-400" />
                      ) : (
                        <FileIcon filename={entry.name} grayscale size={16} className="shrink-0 opacity-75" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-xs font-medium">{entry.name}</div>
                        <div className="truncate font-mono text-[10px] text-neutral-600">
                          {homePathLabel(entry.path, homePath)}
                        </div>
                      </div>
                      {entry.isProject ? (
                        <span className="flex shrink-0 items-center gap-1 rounded-md bg-blue-400/10 px-1.5 py-0.5 text-[10px] font-medium text-blue-300">
                          <FolderKanban className="size-3" />
                          Project
                        </span>
                      ) : null}
                      <span className="shrink-0 text-[10px] text-neutral-600">
                        {entry.kind === 'directory' ? 'Folder' : 'File'}
                      </span>
                    </div>
                  );
                })
              ) : loading ? (
                <div className="px-3 py-3 text-xs text-neutral-600">Searching…</div>
              ) : (
                <div className="px-3 py-3 text-xs text-neutral-600">No matching paths.</div>
              )}
            </div>
            <div className="flex items-center gap-3 border-t border-neutral-800 px-3 py-1.5 text-[10px] text-neutral-600">
              <span><kbd>↑↓</kbd> select</span>
              <span><kbd>Tab</kbd> complete</span>
              <span><kbd>Enter</kbd> open</span>
              <span><kbd>Esc</kbd> close</span>
            </div>
          </div>
        ) : null}
      </div>
      <Button
        aria-label="Open typed path"
        isIconOnly
        size="sm"
        type="button"
        variant="secondary"
        onPress={openTypedPath}
      >
        <ArrowRight className="size-3.5" />
      </Button>
    </form>
  );
}
