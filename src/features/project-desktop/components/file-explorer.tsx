import { useEffect, useState } from 'react';
import { FileIcon, Icon } from '@dotnaos/react-ui';
import { ChevronLeft, ChevronRight, Folder, FolderOpen } from 'lucide-react';
import { ScrollShadow, Text } from '@/app/dotnaos-ui';
import { projectSpaceClient } from '@/api/project-space-client';
import { cn } from '@/lib/utils';
import type { FileSystemEntry } from '@/shared/project-space-api';

interface FileExplorerProps {
  onBack(): void;
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

    void projectSpaceClient.readDirectory(entry.path).then((nextEntries) => {
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
        className={cn(
          'group flex min-h-8 w-full min-w-0 items-center gap-2 rounded-md py-1.5 pr-3 text-left text-sm transition',
          expandable
            ? 'text-neutral-300 hover:bg-neutral-800/70 hover:text-neutral-50'
            : 'text-neutral-500 hover:bg-neutral-800/40 hover:text-neutral-300'
        )}
        style={{ paddingLeft: `${level * 16 + 14}px` }}
      >
        <span className="flex size-4 shrink-0 items-center justify-center text-neutral-500">
          {expandable ? (
            <ChevronRight
              className={cn('size-3.5 transition-transform', expanded && 'rotate-90')}
              strokeWidth={2}
            />
          ) : null}
        </span>
        <span className="flex size-5 shrink-0 items-center justify-center">
          {expandable ? (
            <Icon
              name={expanded ? FolderOpen : Folder}
              size="m"
              color="inherit"
              className="text-neutral-400 group-hover:text-neutral-200"
            />
          ) : (
            <FileIcon filename={entry.name} size={18} grayscale className="opacity-85" />
          )}
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
          <Text
            style={{ paddingLeft: `${(level + 1) * 16 + 27}px` }}
            className="py-1 text-xs text-neutral-600"
          >
            Empty
          </Text>
        ) : null
      ) : null}
    </div>
  );
}

function BackToWorkspaceRow({ onBack }: { onBack(): void }) {
  return (
    <button
      type="button"
      onClick={onBack}
      className="flex min-h-8 w-full items-center gap-2 rounded-xl py-1.5 pr-3 pl-3 text-left text-sm font-medium text-neutral-400 transition hover:bg-neutral-800/70 hover:text-neutral-100"
    >
      <ChevronLeft className="size-4 shrink-0" strokeWidth={1.8} />
      Workspace
    </button>
  );
}

export function FileExplorer({
  onBack,
  rootPath
}: FileExplorerProps) {
  const [entries, setEntries] = useState<FileSystemEntry[]>([]);

  useEffect(() => {
    if (!rootPath) {
      setEntries([]);
      return;
    }

    let canceled = false;

    void projectSpaceClient.readDirectory(rootPath).then((nextEntries) => {
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
      <ScrollShadow className="flex-1 px-3 py-4" hideScrollBar>
        <div className="space-y-1">
          <BackToWorkspaceRow onBack={onBack} />
          <Text className="px-3 py-2 text-sm text-neutral-500">No project selected.</Text>
        </div>
      </ScrollShadow>
    );
  }

  return (
    <ScrollShadow className="flex-1 px-3 py-4" hideScrollBar>
      <div className="space-y-1">
        <BackToWorkspaceRow onBack={onBack} />
        <Text className="px-3 py-2 text-[11px] uppercase tracking-[0.18em] text-neutral-500">
          {pathBasename(rootPath)}
        </Text>
        {entries.map((entry) => (
          <FileTreeNode key={entry.path} entry={entry} level={0} />
        ))}
      </div>
    </ScrollShadow>
  );
}
