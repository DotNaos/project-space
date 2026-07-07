import { useState } from 'react';
import { ChevronDown, FileCode2, FileMinus2, FilePlus2 } from 'lucide-react';
import { Text } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import { highlightDiffLine, languageForPath } from './diff-highlight';

interface DiffLine {
  kind: 'add' | 'remove' | 'context' | 'meta';
  newNumber?: number;
  oldNumber?: number;
  text: string;
}

interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  isBinary: boolean;
  kind: 'modified' | 'added' | 'deleted' | 'renamed';
  newPath: string;
  oldPath: string;
}

function stripDiffPathPrefix(path: string) {
  return path.replace(/^[ab]\//, '');
}

export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const paths = /^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/.exec(line);
      file = {
        additions: 0,
        deletions: 0,
        hunks: [],
        isBinary: false,
        kind: 'modified',
        newPath: paths?.[2] ?? '',
        oldPath: paths?.[1] ?? ''
      };
      hunk = null;
      files.push(file);
      continue;
    }

    if (!file) {
      continue;
    }

    if (line.startsWith('new file mode')) {
      file.kind = 'added';
      continue;
    }

    if (line.startsWith('deleted file mode')) {
      file.kind = 'deleted';
      continue;
    }

    if (line.startsWith('rename from ')) {
      file.kind = 'renamed';
      file.oldPath = line.slice('rename from '.length);
      continue;
    }

    if (line.startsWith('rename to ')) {
      file.kind = 'renamed';
      file.newPath = line.slice('rename to '.length);
      continue;
    }

    if (line.startsWith('Binary files ')) {
      file.isBinary = true;
      continue;
    }

    if (line.startsWith('--- ')) {
      const path = line.slice(4).trim();
      if (path !== '/dev/null' && !file.oldPath) {
        file.oldPath = stripDiffPathPrefix(path);
      }
      continue;
    }

    if (line.startsWith('+++ ')) {
      const path = line.slice(4).trim();
      if (path !== '/dev/null' && !file.newPath) {
        file.newPath = stripDiffPathPrefix(path);
      }
      continue;
    }

    if (line.startsWith('@@')) {
      const range = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
      oldLine = range ? Number.parseInt(range[1], 10) : 0;
      newLine = range ? Number.parseInt(range[2], 10) : 0;
      hunk = { header: range?.[3]?.trim() ?? '', lines: [] };
      file.hunks.push(hunk);
      continue;
    }

    if (!hunk) {
      continue;
    }

    if (line.startsWith('+')) {
      file.additions += 1;
      hunk.lines.push({ kind: 'add', newNumber: newLine, text: line.slice(1) });
      newLine += 1;
      continue;
    }

    if (line.startsWith('-')) {
      file.deletions += 1;
      hunk.lines.push({ kind: 'remove', oldNumber: oldLine, text: line.slice(1) });
      oldLine += 1;
      continue;
    }

    if (line.startsWith('\\')) {
      hunk.lines.push({ kind: 'meta', text: line });
      continue;
    }

    hunk.lines.push({
      kind: 'context',
      newNumber: newLine,
      oldNumber: oldLine,
      text: line.slice(1)
    });
    oldLine += 1;
    newLine += 1;
  }

  return files;
}

const fileKindIcon = {
  added: FilePlus2,
  deleted: FileMinus2,
  modified: FileCode2,
  renamed: FileCode2
};

function DiffStat({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="flex shrink-0 items-center gap-2 font-mono text-[11px]">
      {additions > 0 ? <span className="text-emerald-400">+{additions}</span> : null}
      {deletions > 0 ? <span className="text-red-400">-{deletions}</span> : null}
    </span>
  );
}

const lineToneClass = {
  add: 'bg-emerald-400/[0.08] text-emerald-100',
  context: 'text-neutral-400',
  meta: 'text-neutral-600 italic',
  remove: 'bg-red-400/[0.07] text-red-100/90'
};

const lineMarker = { add: '+', context: ' ', meta: ' ', remove: '-' };

export function DiffFileCard({ file }: { file: DiffFile }) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const Icon = fileKindIcon[file.kind];
  const title =
    file.kind === 'renamed' ? `${file.oldPath} → ${file.newPath}` : file.newPath || file.oldPath;
  const language = languageForPath(file.newPath || file.oldPath);

  return (
    <section className="overflow-hidden rounded-lg border border-neutral-800/80 bg-neutral-950/60">
      <button
        type="button"
        aria-expanded={!isCollapsed}
        onClick={() => setIsCollapsed((current) => !current)}
        className={cn(
          'flex w-full items-center justify-between gap-3 bg-neutral-900/40 px-3 py-2 text-left transition hover:bg-neutral-900/70',
          !isCollapsed && 'border-b border-neutral-800/80'
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          <ChevronDown
            className={cn(
              'size-3.5 shrink-0 text-neutral-500 transition-transform',
              isCollapsed && '-rotate-90'
            )}
          />
          <Icon
            className={cn(
              'size-3.5 shrink-0',
              file.kind === 'added' && 'text-emerald-400',
              file.kind === 'deleted' && 'text-red-400',
              (file.kind === 'modified' || file.kind === 'renamed') && 'text-neutral-500'
            )}
          />
          <Text className="truncate font-mono text-xs text-neutral-200">{title}</Text>
          {file.kind !== 'modified' ? (
            <span
              className={cn(
                'shrink-0 rounded-full border px-1.5 py-0.5 text-[10px]',
                file.kind === 'added' && 'border-emerald-400/25 text-emerald-300',
                file.kind === 'deleted' && 'border-red-400/25 text-red-300',
                file.kind === 'renamed' && 'border-neutral-700 text-neutral-400'
              )}
            >
              {file.kind}
            </span>
          ) : null}
        </span>
        <DiffStat additions={file.additions} deletions={file.deletions} />
      </button>

      {isCollapsed ? null : file.isBinary ? (
        <Text className="block px-3 py-3 text-xs text-neutral-500">Binary file not shown.</Text>
      ) : file.hunks.length === 0 ? (
        <Text className="block px-3 py-3 text-xs text-neutral-500">No textual changes.</Text>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse font-mono text-[11px] leading-5">
            <tbody>
              {file.hunks.map((hunk, hunkIndex) => (
                <HunkRows
                  key={hunkIndex}
                  hunk={hunk}
                  isFirst={hunkIndex === 0}
                  language={language}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function DiffLineCode({ line, language }: { language?: string; line: DiffLine }) {
  const html = line.kind === 'meta' ? null : highlightDiffLine(line.text, language);

  if (html === null) {
    return <>{line.text}</>;
  }

  return <span className="diff-code" dangerouslySetInnerHTML={{ __html: html }} />;
}

function HunkRows({
  hunk,
  isFirst,
  language
}: {
  hunk: DiffHunk;
  isFirst: boolean;
  language?: string;
}) {
  return (
    <>
      <tr>
        <td
          colSpan={3}
          className={cn(
            'select-none border-b border-neutral-800/60 bg-neutral-900/50 px-3 py-1 text-[10px] text-neutral-500',
            !isFirst && 'border-t'
          )}
        >
          {hunk.header || ' '}
        </td>
      </tr>
      {hunk.lines.map((line, index) => (
        <tr key={index} className={lineToneClass[line.kind]}>
          <td className="w-10 select-none border-r border-neutral-800/40 px-2 text-right align-top text-[10px] text-neutral-600">
            {line.oldNumber ?? ''}
          </td>
          <td className="w-10 select-none border-r border-neutral-800/40 px-2 text-right align-top text-[10px] text-neutral-600">
            {line.newNumber ?? ''}
          </td>
          <td className="whitespace-pre-wrap break-all px-3 align-top">
            <span className="mr-1.5 select-none text-neutral-600">{lineMarker[line.kind]}</span>
            <DiffLineCode line={line} language={language} />
          </td>
        </tr>
      ))}
    </>
  );
}

export function DiffView({
  diff,
  emptyMessage = 'No diff for this selection.'
}: {
  diff: string;
  emptyMessage?: string;
}) {
  const files = parseUnifiedDiff(diff);

  if (files.length === 0) {
    return <Text className="block px-4 py-6 text-sm text-neutral-500">{diff.trim() || emptyMessage}</Text>;
  }

  return (
    <div className="flex flex-col gap-3 p-3">
      {files.map((file, index) => (
        <DiffFileCard key={`${file.oldPath}:${file.newPath}:${index}`} file={file} />
      ))}
    </div>
  );
}
