import { useEffect, useMemo, useState } from 'react';
import { GitCommitHorizontal, GitPullRequest, RefreshCw, Tag } from 'lucide-react';
import { Button, Chip, Surface, Text, Tooltip } from '@/app/dotnaos-ui';
import { projectSpaceClient } from '@/api/project-space-client';
import { cn } from '@/lib/utils';
import type { GitHistoryCommit } from '@/shared/project-space-api';
import {
  buildGitBranchOptions,
  GitBranchSidebar,
  GitCommitDetails
} from './git-graph-browser';

const COMMIT_LIMIT = 300;
const LANE_WIDTH = 14;
const ROW_HEIGHT = 32;

const lanePalette = [
  '#0085d9',
  '#d9008f',
  '#00d90a',
  '#d98500',
  '#a300d9',
  '#ff4d4d',
  '#00d9cc',
  '#e138e8'
];

type GraphCommit = GitHistoryCommit;

interface RowSegment {
  color: string;
  fromColumn: number;
  half: 'top' | 'bottom' | 'full';
  toColumn: number;
}

interface GraphRow {
  color: string;
  column: number;
  commit: GraphCommit;
  segments: RowSegment[];
}

interface Lane {
  color: string;
  hash: string;
}

function layoutGraph(commits: GraphCommit[]): { maxLanes: number; rows: GraphRow[] } {
  const lanes: Array<Lane | null> = [];
  const rows: GraphRow[] = [];
  let colorCursor = 0;
  let maxLanes = 1;

  function takeColor() {
    const color = lanePalette[colorCursor % lanePalette.length];
    colorCursor += 1;
    return color;
  }

  function firstFreeLane() {
    const index = lanes.findIndex((lane) => lane === null);
    return index === -1 ? lanes.length : index;
  }

  for (const commit of commits) {
    const waiting: number[] = [];
    lanes.forEach((lane, index) => {
      if (lane?.hash === commit.hash) {
        waiting.push(index);
      }
    });

    let column: number;
    let color: string;

    if (waiting.length > 0) {
      column = waiting[0];
      color = lanes[column]?.color ?? takeColor();
    } else {
      column = firstFreeLane();
      color = takeColor();
      lanes[column] = { color, hash: commit.hash };
    }

    const segments: RowSegment[] = [];

    lanes.forEach((lane, index) => {
      if (!lane) {
        return;
      }

      if (lane.hash === commit.hash) {
        segments.push({ color: lane.color, fromColumn: index, half: 'top', toColumn: column });
        return;
      }

      segments.push({ color: lane.color, fromColumn: index, half: 'full', toColumn: index });
    });

    for (const index of waiting) {
      lanes[index] = null;
    }

    const [firstParent, ...otherParents] = commit.parents;

    if (firstParent) {
      lanes[column] = { color, hash: firstParent };
      segments.push({ color, fromColumn: column, half: 'bottom', toColumn: column });
    } else {
      lanes[column] = null;
    }

    for (const parent of otherParents) {
      const existing = lanes.findIndex((lane) => lane?.hash === parent);

      if (existing >= 0) {
        segments.push({
          color: lanes[existing]?.color ?? color,
          fromColumn: column,
          half: 'bottom',
          toColumn: existing
        });
        continue;
      }

      const free = firstFreeLane();
      const parentColor = takeColor();
      lanes[free] = { color: parentColor, hash: parent };
      segments.push({ color: parentColor, fromColumn: column, half: 'bottom', toColumn: free });
    }

    while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
      lanes.pop();
    }

    maxLanes = Math.max(maxLanes, lanes.length, column + 1);
    rows.push({ color, column, commit, segments });
  }

  return { maxLanes, rows };
}

function laneX(column: number) {
  return column * LANE_WIDTH + LANE_WIDTH / 2;
}

function segmentPath(segment: RowSegment) {
  const fromX = laneX(segment.fromColumn);
  const toX = laneX(segment.toColumn);
  const mid = ROW_HEIGHT / 2;

  if (segment.half === 'full') {
    return `M ${fromX} 0 L ${fromX} ${ROW_HEIGHT}`;
  }

  if (segment.half === 'top') {
    if (fromX === toX) {
      return `M ${fromX} 0 L ${toX} ${mid}`;
    }

    return `M ${fromX} 0 C ${fromX} ${mid}, ${toX} 0, ${toX} ${mid}`;
  }

  if (fromX === toX) {
    return `M ${fromX} ${mid} L ${toX} ${ROW_HEIGHT}`;
  }

  return `M ${fromX} ${mid} C ${fromX} ${ROW_HEIGHT}, ${toX} ${mid}, ${toX} ${ROW_HEIGHT}`;
}

function RefChips({ refs }: { refs: string[] }) {
  if (refs.length === 0) {
    return null;
  }

  return (
    <span className="flex min-w-0 shrink items-center gap-1 overflow-hidden">
      {refs.map((ref) => {
        const isHead = ref.startsWith('HEAD ->') || ref === 'HEAD';
        const label = ref.replace(/^HEAD -> /, '');
        const isTag = ref.startsWith('tag: ');

        if (isTag) {
          return (
            <Chip
              key={ref}
              size="sm"
              variant="secondary"
              className="max-w-[12rem] shrink-0 border-amber-400/25 text-amber-300"
            >
              <Tag className="size-3" />
              <span className="truncate">{ref.slice('tag: '.length)}</span>
            </Chip>
          );
        }

        return (
          <Chip
            key={ref}
            size="sm"
            variant={isHead ? 'primary' : 'secondary'}
            className="max-w-[12rem] shrink-0"
          >
            <span className="truncate">{label}</span>
          </Chip>
        );
      })}
    </span>
  );
}

function pullRequestLabel(subject: string) {
  const match = /^Merge pull request #(\d+)\b/.exec(subject);
  return match ? `PR #${match[1]}` : null;
}

function CommitDotTooltip({
  color,
  commit,
  isMerge,
  isPullRequest
}: {
  color: string;
  commit: GraphCommit;
  isMerge: boolean;
  isPullRequest: boolean;
}) {
  return (
    <Tooltip delay={120}>
      <Tooltip.Trigger
        aria-label={`Commit ${commit.hash.slice(0, 8)}`}
        className="inline-flex size-4 items-center justify-center rounded-full outline-none transition focus-visible:ring-2 focus-visible:ring-neutral-300"
        data-testid="git-graph-commit-dot"
        tabIndex={0}
      >
        <span
          className={cn(
            'block rounded-full border-2 transition group-hover:scale-110',
            isMerge ? 'size-3' : 'size-2.5'
          )}
          style={{
            backgroundColor: isPullRequest ? '#e5e7eb' : color,
            borderColor: isPullRequest ? color : '#0a0a0a',
            filter: isMerge && !isPullRequest ? 'brightness(1.35) saturate(1.65)' : undefined
          }}
        />
      </Tooltip.Trigger>
      <Tooltip.Content className="w-80 max-w-[calc(100vw-4rem)] space-y-1 text-left">
        <Text className="block break-all font-mono text-[11px] leading-4 text-neutral-400">
          {commit.hash}
        </Text>
        <Text className="block whitespace-normal text-sm leading-5 text-neutral-100">
          {commit.subject}
        </Text>
      </Tooltip.Content>
    </Tooltip>
  );
}

export function GitGraphPanel({
  repositoryFullName,
  targetPath
}: {
  repositoryFullName?: string;
  targetPath: string;
}) {
  const [allCommits, setAllCommits] = useState<GraphCommit[]>([]);
  const [commits, setCommits] = useState<GraphCommit[]>([]);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [selectedHash, setSelectedHash] = useState('');
  const [selectedRef, setSelectedRef] = useState('all');

  async function refresh(nextRef = selectedRef) {
    if (!targetPath) {
      setAllCommits([]);
      setCommits([]);
      return;
    }

    setIsLoading(true);
    setError('');
    try {
      const allResult = await projectSpaceClient.getGitHistory({
        cwd: targetPath,
        limit: COMMIT_LIMIT,
        repositoryFullName
      });

      if (!allResult.isRepository) {
        setAllCommits([]);
        setCommits([]);
        setError(allResult.message ?? 'Could not read the git history.');
        return;
      }

      setAllCommits(allResult.commits);

      const nextCommits =
        nextRef === 'all'
          ? allResult.commits
          : (
              await projectSpaceClient.getGitHistory({
                cwd: targetPath,
                limit: COMMIT_LIMIT,
                ref: nextRef,
                repositoryFullName
              })
            ).commits;

      setCommits(nextCommits);
      setSelectedHash((previousHash) =>
        nextCommits.some((commit) => commit.hash === previousHash)
          ? previousHash
          : nextCommits[0]?.hash ?? ''
      );
      setError(allResult.message ?? '');
    } catch (requestError) {
      setAllCommits([]);
      setCommits([]);
      setError(
        requestError instanceof Error ? requestError.message : 'Could not read the git history.'
      );
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    setSelectedRef('all');
    void refresh('all');
  }, [repositoryFullName, targetPath]);

  const branchOptions = useMemo(
    () => buildGitBranchOptions(allCommits.length > 0 ? allCommits : commits),
    [allCommits, commits]
  );
  const { maxLanes, rows } = useMemo(() => layoutGraph(commits), [commits]);
  const graphWidth = maxLanes * LANE_WIDTH;
  const selectedCommit = commits.find((commit) => commit.hash === selectedHash) ?? commits[0];
  const selectedLabel =
    selectedRef === 'all'
      ? 'all branches'
      : branchOptions.find((branch) => branch.ref === selectedRef)?.label ?? selectedRef;

  return (
    <Surface
      variant="tertiary"
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950/45"
    >
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-neutral-800 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <GitCommitHorizontal className="size-4 shrink-0 text-neutral-400" />
          <Text className="truncate text-sm font-semibold text-neutral-100">Commit graph</Text>
          <Text className="shrink-0 text-xs text-neutral-500">
            {rows.length > 0
              ? `${rows.length}${rows.length >= COMMIT_LIMIT ? '+' : ''} commits, ${selectedLabel}`
              : ''}
          </Text>
        </div>
        <Button
          aria-label="Refresh history"
          size="sm"
          variant="ghost"
          isDisabled={!targetPath || isLoading}
          onPress={() => void refresh()}
        >
          <RefreshCw className={isLoading ? 'size-4 animate-spin' : 'size-4'} />
        </Button>
      </div>

      {error ? (
        <Text className="block px-4 py-6 text-sm text-neutral-500">{error}</Text>
      ) : rows.length === 0 ? (
        <Text className="block px-4 py-6 text-sm text-neutral-500">
          {isLoading ? 'Loading history...' : 'No commits found.'}
        </Text>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[12rem_minmax(0,1fr)_14rem] overflow-hidden">
          <GitBranchSidebar
            branches={branchOptions}
            isLoading={isLoading}
            onSelectRef={(ref) => {
              setSelectedRef(ref);
              void refresh(ref);
            }}
            selectedRef={selectedRef}
          />
          <div data-testid="git-graph-scroll" className="min-h-0 min-w-0 overflow-auto">
            <div className="min-w-fit py-1">
              {rows.map((row) => {
                const isMerge = row.commit.parents.length > 1;
                const isSelected = row.commit.hash === selectedCommit?.hash;
                const prLabel = pullRequestLabel(row.commit.subject);

                return (
                  <div
                    key={row.commit.hash}
                    className={cn(
                      'group flex min-w-0 cursor-pointer items-center gap-3 px-3 outline-none transition hover:bg-neutral-900/50 focus-visible:bg-neutral-900/70',
                      isSelected && 'bg-neutral-800/70 hover:bg-neutral-800/70'
                    )}
                    onClick={() => setSelectedHash(row.commit.hash)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setSelectedHash(row.commit.hash);
                      }
                    }}
                    role="button"
                    style={{ height: ROW_HEIGHT }}
                    tabIndex={0}
                  >
                    <span
                      className="relative shrink-0"
                      style={{ width: graphWidth, height: ROW_HEIGHT }}
                    >
                      <svg
                        aria-hidden="true"
                        width={graphWidth}
                        height={ROW_HEIGHT}
                        className="pointer-events-none absolute inset-0"
                      >
                        {row.segments.map((segment, index) => (
                          <path
                            key={index}
                            d={segmentPath(segment)}
                            fill="none"
                            stroke={segment.color}
                            strokeWidth={2}
                          />
                        ))}
                      </svg>
                      <span
                        className="absolute"
                        style={{
                          left: laneX(row.column),
                          top: ROW_HEIGHT / 2,
                          transform: 'translate(-50%, -50%)'
                        }}
                      >
                        <CommitDotTooltip
                          color={row.color}
                          commit={row.commit}
                          isMerge={isMerge}
                          isPullRequest={Boolean(prLabel)}
                        />
                      </span>
                    </span>

                    <span className="flex w-[18rem] min-w-0 shrink-0 items-center gap-1.5 sm:w-[22rem]">
                      <RefChips refs={row.commit.refs} />
                      {prLabel ? (
                        <Chip
                          size="sm"
                          variant="secondary"
                          className="gap-1 rounded-full border border-sky-400/25 bg-sky-400/10 px-1.5 py-0.5 text-sky-200"
                        >
                          <GitPullRequest className="size-3 shrink-0" />
                          <span>{prLabel}</span>
                        </Chip>
                      ) : null}
                      <Text
                        className={cn(
                          'min-w-0 truncate text-sm',
                          isMerge ? 'text-neutral-500' : 'text-neutral-200'
                        )}
                      >
                        {row.commit.subject}
                      </Text>
                    </span>

                    <Text className="w-24 shrink-0 text-xs text-neutral-500">
                      {row.commit.date}
                    </Text>
                    <Text className="w-36 shrink-0 truncate text-xs text-neutral-500">
                      {row.commit.author}
                    </Text>
                    <Text className="shrink-0 font-mono text-xs text-neutral-600">
                      {row.commit.hash.slice(0, 8)}
                    </Text>
                  </div>
                );
              })}
            </div>
          </div>
          <GitCommitDetails commit={selectedCommit} />
        </div>
      )}
    </Surface>
  );
}
