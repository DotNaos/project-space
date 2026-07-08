import { useEffect, useState } from 'react';
import { FileIcon, Icon } from '@dotnaos/react-ui';
import { ChevronLeft, ChevronRight, Folder, FolderOpen } from 'lucide-react';
import { ScrollShadow, Text } from '@/app/dotnaos-ui';
import { projectSpaceClient } from '@/api/project-space-client';
import { cn } from '@/lib/utils';
import type { FileSystemEntry, GitStatusEntry } from '@/shared/project-space-api';

interface FileExplorerProps {
  gitStatus?: FileExplorerGitStatus;
  onBack?(): void;
  rootPath?: string;
}

interface FileExplorerGitStatus {
  entries: GitStatusEntry[];
  repositoryRoot: string;
}

type GitExplorerTone = 'modified' | 'staged' | 'untracked';

function pathBasename(path: string) {
  return path.split('/').filter(Boolean).pop() ?? path;
}

function stripTrailingSlash(path: string) {
  return path.replace(/\/+$/, '');
}

function relativePath(repositoryRoot: string, entryPath: string) {
  const root = stripTrailingSlash(repositoryRoot);
  const path = stripTrailingSlash(entryPath);

  if (path === root) {
    return '';
  }

  if (path.startsWith(`${root}/`)) {
    return path.slice(root.length + 1);
  }

  return path;
}

function normalizeGitPath(path: string) {
  const renameTarget = path.includes(' -> ') ? path.split(' -> ').pop() : path;

  return (renameTarget ?? path).replace(/^"|"$/g, '');
}

function toneForGitEntry(entry: GitStatusEntry): GitExplorerTone {
  if (entry.displayStatus === '??') {
    return 'untracked';
  }

  if (entry.indexStatus.trim() && !entry.worktreeStatus.trim()) {
    return 'staged';
  }

  return 'modified';
}

function pickTone(current: GitExplorerTone | undefined, next: GitExplorerTone) {
  const priority: Record<GitExplorerTone, number> = {
    modified: 3,
    untracked: 2,
    staged: 1
  };

  if (!current || priority[next] > priority[current]) {
    return next;
  }

  return current;
}

function gitToneForEntry(entry: FileSystemEntry, gitStatus?: FileExplorerGitStatus) {
  if (!gitStatus) {
    return undefined;
  }

  const relative = relativePath(gitStatus.repositoryRoot, entry.path);

  if (!relative) {
    return undefined;
  }

  let tone: GitExplorerTone | undefined;

  for (const statusEntry of gitStatus.entries) {
    const statusPath = normalizeGitPath(statusEntry.path);
    const matches =
      entry.kind === 'directory' ? statusPath.startsWith(`${relative}/`) : statusPath === relative;

    if (matches) {
      tone = pickTone(tone, toneForGitEntry(statusEntry));
    }
  }

  return tone;
}

function gitToneClass(tone: GitExplorerTone | undefined, target: 'dot' | 'icon' | 'text' | 'row') {
  if (!tone) {
    return '';
  }

  if (target === 'dot') {
    return tone === 'modified'
      ? 'bg-amber-300'
      : tone === 'untracked'
        ? 'bg-violet-300'
        : 'bg-emerald-300';
  }

  if (target === 'row') {
    return tone === 'modified'
      ? 'bg-amber-400/4 hover:bg-amber-400/8'
      : tone === 'untracked'
        ? 'bg-violet-400/4 hover:bg-violet-400/8'
        : 'bg-emerald-400/4 hover:bg-emerald-400/8';
  }

  if (target === 'icon') {
    return tone === 'modified'
      ? 'text-amber-300'
      : tone === 'untracked'
        ? 'text-violet-300'
        : 'text-emerald-300';
  }

  return tone === 'modified'
    ? 'text-amber-100'
    : tone === 'untracked'
      ? 'text-violet-100'
      : 'text-emerald-100';
}

function gitToneLabel(tone: GitExplorerTone) {
  return tone === 'modified' ? 'modified' : tone === 'untracked' ? 'untracked' : 'staged';
}

interface FileTreeNodeProps {
  entry: FileSystemEntry;
  gitStatus?: FileExplorerGitStatus;
  level: number;
}

function FileTreeNode({
  entry,
  gitStatus,
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
  const gitTone = gitToneForEntry(entry, gitStatus);

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
            : 'text-neutral-500 hover:bg-neutral-800/40 hover:text-neutral-300',
          gitToneClass(gitTone, 'row')
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
              className={cn(
                'text-neutral-400 group-hover:text-neutral-200',
                gitToneClass(gitTone, 'icon')
              )}
            />
          ) : (
            <FileIcon
              filename={entry.name}
              size={18}
              grayscale
              className={cn('opacity-85', gitToneClass(gitTone, 'icon'))}
            />
          )}
        </span>
        <span className={cn('min-w-0 flex-1 truncate', gitToneClass(gitTone, 'text'))}>
          {entry.name}
        </span>
        {gitTone ? (
          <span
            aria-label={gitToneLabel(gitTone)}
            className={cn('size-1.5 shrink-0 rounded-full', gitToneClass(gitTone, 'dot'))}
          />
        ) : null}
      </button>

      {expandable && expanded ? (
        children.length > 0 ? (
          <div>
            {children.map((child) => (
              <FileTreeNode
                key={child.path}
                entry={child}
                gitStatus={gitStatus}
                level={level + 1}
              />
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
  gitStatus,
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
          {onBack ? <BackToWorkspaceRow onBack={onBack} /> : null}
          <Text className="px-3 py-2 text-sm text-neutral-500">No project selected.</Text>
        </div>
      </ScrollShadow>
    );
  }

  return (
    <ScrollShadow className="flex-1 px-3 py-4" hideScrollBar>
      <div className="space-y-1">
        {onBack ? <BackToWorkspaceRow onBack={onBack} /> : null}
        <Text className="px-3 py-2 text-[11px] uppercase tracking-[0.18em] text-neutral-500">
          {pathBasename(rootPath)}
        </Text>
        {entries.map((entry) => (
          <FileTreeNode key={entry.path} entry={entry} gitStatus={gitStatus} level={0} />
        ))}
      </div>
    </ScrollShadow>
  );
}
