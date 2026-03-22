import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import type { FileSystemEntry } from '@/shared/electron-api';

interface FileExplorerProps {
  rootPath?: string;
}

function pathBasename(path: string) {
  return path.split('/').filter(Boolean).pop() ?? path;
}

interface FileTreeNodeProps {
  entry: FileSystemEntry;
  level: number;
}

function FileTreeNode({
  entry,
  level
}: FileTreeNodeProps) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FileSystemEntry[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (entry.kind !== 'directory' || !expanded || loaded) {
      return;
    }

    let canceled = false;

    void window.projectSpace.readDirectory(entry.path).then((nextEntries) => {
      if (canceled) {
        return;
      }

      setChildren(nextEntries);
      setLoaded(true);
    });

    return () => {
      canceled = true;
    };
  }, [entry.kind, entry.path, expanded, loaded]);

  const expandable = entry.kind === 'directory';

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          if (expandable) {
            setExpanded((current) => !current);
          }
        }}
        style={{ paddingLeft: `${level * 16 + 14}px` }}
        className={cn(
          'flex w-full items-center gap-2 rounded-lg py-2 pr-3 text-left text-sm transition',
          expandable
            ? 'text-slate-300 hover:bg-slate-800/70 hover:text-slate-50'
            : 'text-slate-500 hover:bg-slate-800/40 hover:text-slate-300'
        )}
      >
        <span className="w-3 shrink-0 text-center text-[10px] text-slate-500">
          {expandable ? (expanded ? '▾' : '▸') : ''}
        </span>
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
      </button>

      {expandable && expanded ? (
        children.length > 0 ? (
          <div>
            {children.map((child) => (
              <FileTreeNode key={child.path} entry={child} level={level + 1} />
            ))}
          </div>
        ) : loaded ? (
          <p
            style={{ paddingLeft: `${(level + 1) * 16 + 27}px` }}
            className="py-1 text-xs text-slate-600"
          >
            Empty
          </p>
        ) : null
      ) : null}
    </div>
  );
}

export function FileExplorer({
  rootPath
}: FileExplorerProps) {
  const [entries, setEntries] = useState<FileSystemEntry[]>([]);

  useEffect(() => {
    if (!rootPath) {
      setEntries([]);
      return;
    }

    let canceled = false;

    void window.projectSpace.readDirectory(rootPath).then((nextEntries) => {
      if (canceled) {
        return;
      }

      setEntries(nextEntries);
    });

    return () => {
      canceled = true;
    };
  }, [rootPath]);

  if (!rootPath) {
    return (
      <section className="flex-1 overflow-y-auto px-3 py-4">
        <p className="px-3 py-2 text-sm text-slate-500">No project selected.</p>
      </section>
    );
  }

  return (
    <section className="flex-1 overflow-y-auto px-3 py-4">
      <div className="space-y-1">
        <div className="px-3 py-2 text-[11px] uppercase tracking-[0.18em] text-slate-500">
          {pathBasename(rootPath)}
        </div>
        {entries.map((entry) => (
          <FileTreeNode key={entry.path} entry={entry} level={0} />
        ))}
      </div>
    </section>
  );
}
