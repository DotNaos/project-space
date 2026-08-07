import { useMemo, useState } from 'react';
import { ChevronRight, FileText, Folder, FolderOpen, Search } from 'lucide-react';
import { Text } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import {
  buildGitHubTreeNodes,
  type GitHubTreeEntry,
  type GitHubTreeNode
} from '@/shared/github-repository-tree';
import { highlightDiffLine, languageForPath } from '../project-desktop/components/diff-highlight';
import { formatExplorerFileSize } from '../project-desktop/components/explorer-file-format';

function TreeRow({
  depth,
  expanded,
  node,
  onSelect,
  onToggle,
  selectedPath
}: {
  depth: number;
  expanded: ReadonlySet<string>;
  node: GitHubTreeNode;
  onSelect(path: string): void;
  onToggle(path: string): void;
  selectedPath: string;
}) {
  const isTree = node.type === 'tree';
  const isOpen = expanded.has(node.path);
  const isSelected = selectedPath === node.path;
  const FolderIcon = isOpen ? FolderOpen : Folder;

  return (
    <>
      <button
        aria-current={isSelected ? 'true' : undefined}
        className={cn(
          'flex w-full min-w-0 items-center gap-1.5 py-1.5 pr-2 text-left text-sm transition',
          isSelected
            ? 'bg-neutral-800/80 text-neutral-100'
            : 'text-neutral-400 hover:bg-neutral-900/50 hover:text-neutral-200'
        )}
        onClick={() => (isTree ? onToggle(node.path) : onSelect(node.path))}
        style={{ paddingLeft: `${0.5 + depth * 0.75}rem` }}
        type="button"
      >
        {isTree ? (
          <ChevronRight
            className={cn('size-3 shrink-0 text-neutral-600 transition-transform', isOpen && 'rotate-90')}
          />
        ) : (
          <span className="size-3 shrink-0" />
        )}
        {isTree ? (
          <FolderIcon className="size-3.5 shrink-0 text-neutral-600" />
        ) : (
          <FileText className="size-3.5 shrink-0 text-neutral-700" />
        )}
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
        {!isTree && node.size !== undefined ? (
          <span className="shrink-0 text-[11px] text-neutral-700">
            {formatExplorerFileSize(node.size)}
          </span>
        ) : null}
      </button>
      {isTree && isOpen
        ? node.children.map((child) => (
            <TreeRow
              depth={depth + 1}
              expanded={expanded}
              key={child.path}
              node={child}
              onSelect={onSelect}
              onToggle={onToggle}
              selectedPath={selectedPath}
            />
          ))
        : null}
    </>
  );
}

function FileBody({ content, path }: { content: string; path: string }) {
  const language = languageForPath(path);
  const lines = useMemo(() => content.split('\n'), [content]);

  return (
    <div className="min-w-0 overflow-auto">
      <pre className="min-w-max px-4 py-3 font-mono text-xs leading-5 text-neutral-300">
        {lines.map((line, index) => {
          const highlighted = highlightDiffLine(line, language);
          return (
            <div className="flex min-w-0" key={index}>
              <span className="mr-4 w-10 shrink-0 select-none text-right text-neutral-700">
                {index + 1}
              </span>
              {highlighted === null ? (
                <span>{line || ' '}</span>
              ) : (
                <span className="diff-code" dangerouslySetInnerHTML={{ __html: highlighted || '&nbsp;' }} />
              )}
            </div>
          );
        })}
      </pre>
    </div>
  );
}

export function TemplateFileExplorer({
  entries,
  fileContent,
  fileMessage,
  isLoadingFile,
  isLoadingTree,
  onSelectPath,
  selectedPath,
  treeError,
  truncated
}: {
  entries: readonly GitHubTreeEntry[];
  fileContent?: string;
  fileMessage: string;
  isLoadingFile: boolean;
  isLoadingTree: boolean;
  onSelectPath(path: string): void;
  selectedPath: string;
  treeError: string;
  truncated: boolean;
}) {
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['template', 'schema']));
  const nodes = useMemo(() => buildGitHubTreeNodes(entries), [entries]);
  const normalizedQuery = query.trim().toLowerCase();
  const matches = useMemo(() => (
    normalizedQuery
      ? entries
          .filter((entry) => entry.type === 'blob' && entry.path.toLowerCase().includes(normalizedQuery))
          .slice(0, 200)
      : []
  ), [entries, normalizedQuery]);

  function toggle(path: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  return (
    <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <div className="flex min-h-0 flex-col rounded-xl border border-neutral-800/70">
        <div className="shrink-0 border-b border-neutral-800/70 p-2">
          <label className="flex h-9 items-center gap-2 rounded-full bg-neutral-900/80 px-3">
            <Search className="size-3.5 shrink-0 text-neutral-600" />
            <span className="sr-only">Find a file</span>
            <input
              aria-label="Find a file"
              className="min-w-0 flex-1 bg-transparent text-sm text-neutral-100 outline-none placeholder:text-neutral-600"
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="Find a file"
              type="search"
              value={query}
            />
          </label>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {isLoadingTree ? (
            <Text className="block px-3 py-4 text-sm text-neutral-600">Loading the tree…</Text>
          ) : treeError ? (
            <Text className="block px-3 py-4 text-sm text-red-300/80">{treeError}</Text>
          ) : normalizedQuery ? (
            matches.length === 0 ? (
              <Text className="block px-3 py-4 text-sm text-neutral-600">No file matches.</Text>
            ) : (
              matches.map((entry) => (
                <button
                  aria-current={selectedPath === entry.path ? 'true' : undefined}
                  className={cn(
                    'flex w-full min-w-0 items-center gap-1.5 px-3 py-1.5 text-left text-sm transition',
                    selectedPath === entry.path
                      ? 'bg-neutral-800/80 text-neutral-100'
                      : 'text-neutral-400 hover:bg-neutral-900/50 hover:text-neutral-200'
                  )}
                  key={entry.path}
                  onClick={() => onSelectPath(entry.path)}
                  type="button"
                >
                  <FileText className="size-3.5 shrink-0 text-neutral-700" />
                  <span className="min-w-0 flex-1 truncate">{entry.path}</span>
                </button>
              ))
            )
          ) : (
            nodes.map((node) => (
              <TreeRow
                depth={0}
                expanded={expanded}
                key={node.path}
                node={node}
                onSelect={onSelectPath}
                onToggle={toggle}
                selectedPath={selectedPath}
              />
            ))
          )}
          {truncated ? (
            <Text className="block px-3 py-3 text-[11px] text-amber-300/80">
              GitHub truncated this tree. Some paths are missing.
            </Text>
          ) : null}
        </div>
      </div>

      <div className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-neutral-800/70">
        {selectedPath ? (
          <div className="flex shrink-0 items-center gap-2 border-b border-neutral-800/70 px-4 py-2.5">
            <FileText className="size-3.5 shrink-0 text-neutral-600" />
            <Text className="min-w-0 flex-1 truncate font-mono text-xs text-neutral-400">
              {selectedPath}
            </Text>
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-auto">
          {!selectedPath ? (
            <div className="grid min-h-48 place-items-center px-6 text-center">
              <Text className="text-sm text-neutral-600">Select a file to read it.</Text>
            </div>
          ) : isLoadingFile ? (
            <Text className="block px-4 py-4 text-sm text-neutral-600">Loading the file…</Text>
          ) : fileContent === undefined ? (
            <div className="grid min-h-48 place-items-center px-6 text-center">
              <Text className="text-sm text-neutral-600">
                {fileMessage || 'This file cannot be shown.'}
              </Text>
            </div>
          ) : (
            <FileBody content={fileContent} path={selectedPath} />
          )}
        </div>
      </div>
    </div>
  );
}
