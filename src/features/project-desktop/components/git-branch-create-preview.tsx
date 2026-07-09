import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { GitBranch, Loader2 } from 'lucide-react';
import { Text } from '@/app/dotnaos-ui';
import { projectSpaceClient } from '@/api/project-space-client';
import { cn } from '@/lib/utils';
import type { GitHistoryCommit } from '@/shared/project-space-api';
import {
  GRAPH_LANE_WIDTH,
  GRAPH_ROW_HEIGHT,
  gitGraphPalette,
  gitGraphLaneX,
  gitGraphPreviewColumn,
  gitGraphPreviewEdgePath,
  gitGraphPreviewPassthroughSegments,
  gitGraphSegmentPath,
  layoutGitGraph
} from './git-graph-layout';

const PREVIEW_LIMIT = 140;
const PREVIEW_GRAPH_WIDTH = 104;
const NEW_BRANCH_COLOR = gitGraphPalette[1] ?? '#d9008f';
const PREVIEW_DOT_RADIUS = 7;

function cleanBranchRef(ref: string) {
  const cleanRef = ref.replace(/^HEAD -> /, '').trim();

  if (!cleanRef || cleanRef === 'HEAD' || cleanRef === 'origin/HEAD' || cleanRef.startsWith('tag: ')) {
    return null;
  }

  return cleanRef.startsWith('origin/') ? cleanRef.slice('origin/'.length) : cleanRef;
}

function commitHasBranch(commit: GitHistoryCommit, branchName: string) {
  return commit.refs.some((ref) => cleanBranchRef(ref) === branchName);
}

export function GitBranchCreatePreview({
  baseBranchName,
  branchName,
  repositoryFullName
}: {
  baseBranchName: string;
  branchName: string;
  isBaseDefaultBranch?: boolean;
  repositoryFullName?: string;
}) {
  const [commits, setCommits] = useState<GitHistoryCommit[]>([]);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isZooming, setIsZooming] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  useEffect(() => {
    let canceled = false;

    async function loadPreview() {
      if (!repositoryFullName) {
        setCommits([]);
        setError('No repository is linked for the graph preview.');
        return;
      }

      setIsLoading(true);
      setError('');

      try {
        const result = await projectSpaceClient.getGitHistory({
          limit: PREVIEW_LIMIT,
          repositoryFullName
        });

        if (canceled) {
          return;
        }

        if (!result.isRepository) {
          setCommits([]);
          setError(result.message ?? 'Could not read the git history.');
          return;
        }

        if (result.commits.some((commit) => commitHasBranch(commit, baseBranchName))) {
          setCommits(result.commits);
          return;
        }

        const branchResult = await projectSpaceClient.getGitHistory({
          limit: PREVIEW_LIMIT,
          ref: baseBranchName,
          repositoryFullName
        });

        if (canceled) {
          return;
        }

        setCommits(branchResult.isRepository ? branchResult.commits : result.commits);
      } catch (requestError) {
        if (!canceled) {
          setCommits([]);
          setError(requestError instanceof Error ? requestError.message : 'Could not load preview.');
        }
      } finally {
        if (!canceled) {
          setIsLoading(false);
        }
      }
    }

    void loadPreview();

    return () => {
      canceled = true;
    };
  }, [baseBranchName, repositoryFullName]);

  const targetCommit = useMemo(
    () => commits.find((commit) => commitHasBranch(commit, baseBranchName)) ?? commits[0],
    [baseBranchName, commits]
  );
  const targetHash = targetCommit?.hash ?? '';
  const branchColorByTipHash = useMemo(() => {
    const colors = new Map<string, string>();

    if (targetCommit) {
      colors.set(targetCommit.hash, gitGraphPalette[0] ?? '#0085d9');
    }

    return colors;
  }, [targetCommit]);
  const { maxLanes, rows } = useMemo(
    () => layoutGitGraph(commits, branchColorByTipHash),
    [branchColorByTipHash, commits]
  );
  const targetRow = useMemo(
    () => rows.find((row) => row.commit.hash === targetHash),
    [rows, targetHash]
  );
  const graphOffsetX = 0;
  const graphWidth = Math.max(graphOffsetX + maxLanes * GRAPH_LANE_WIDTH, 42);

  function laneX(column: number) {
    return graphOffsetX + gitGraphLaneX(column);
  }

  useEffect(() => {
    const targetNode = targetHash ? rowRefs.current.get(targetHash) : null;

    if (!targetNode) {
      return;
    }

    requestAnimationFrame(() => {
      targetNode.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setIsZooming(true);
      window.setTimeout(() => setIsZooming(false), 850);
    });
  }, [targetHash]);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col rounded-lg border border-neutral-800 bg-neutral-950/60">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-neutral-800 px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-neutral-100">
            <GitBranch className="size-4 text-sky-300" />
            Commit graph preview
          </div>
          <Text className="mt-0.5 block truncate text-xs text-neutral-500">
            Preview jumps to the selected base branch tip.
          </Text>
        </div>
        {isLoading ? <Loader2 className="size-4 shrink-0 animate-spin text-neutral-500" /> : null}
      </div>

      {error ? (
        <Text className="block px-4 py-8 text-sm text-neutral-500">{error}</Text>
      ) : rows.length === 0 ? (
        <Text className="block px-4 py-8 text-sm text-neutral-500">
          {isLoading ? 'Loading graph preview...' : 'No commits found.'}
        </Text>
      ) : (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-2">
          <div className="w-full min-w-0">
            {rows.map((row) => {
              const isTarget = row.commit.hash === targetHash;
              const baseX = laneX(row.column);
              const previewColumn = isTarget ? gitGraphPreviewColumn(row, maxLanes) : row.column;
              const previewX = laneX(previewColumn);
              const graphCellWidth = Math.max(
                PREVIEW_GRAPH_WIDTH,
                baseX + GRAPH_LANE_WIDTH,
                previewX + GRAPH_LANE_WIDTH,
                Math.min(graphWidth, PREVIEW_GRAPH_WIDTH)
              );
              const previewPassthroughSegments = isTarget
                ? gitGraphPreviewPassthroughSegments(row)
                : [];
              const midY = GRAPH_ROW_HEIGHT / 2;

              return (
                <Fragment key={row.commit.hash}>
                  {isTarget ? (
                    <div
                      className="flex w-full min-w-0 items-center gap-3 border-y border-fuchsia-500/10 bg-fuchsia-500/[0.07] px-3"
                      style={{ height: GRAPH_ROW_HEIGHT }}
                    >
                      <span
                        className="relative shrink-0"
                        style={{ width: graphCellWidth, height: GRAPH_ROW_HEIGHT }}
                      >
                        <svg
                          aria-hidden="true"
                          width={graphCellWidth}
                          height={GRAPH_ROW_HEIGHT}
                          className="pointer-events-none absolute inset-0"
                        >
                          <g transform={`translate(${graphOffsetX} 0)`}>
                            {previewPassthroughSegments.map((segment) => (
                              <path
                                key={segment.column}
                                d={`M ${gitGraphLaneX(segment.column)} 0 L ${gitGraphLaneX(segment.column)} ${GRAPH_ROW_HEIGHT}`}
                                fill="none"
                                stroke={segment.color}
                                strokeLinecap="round"
                                strokeOpacity={0.9}
                                strokeWidth={2.5}
                              />
                            ))}
                          </g>
                        </svg>
                        <span
                          className="absolute size-3.5 rounded-full border-2 ring-4 ring-fuchsia-400/20"
                          style={{
                            backgroundColor: `${NEW_BRANCH_COLOR}22`,
                            borderColor: NEW_BRANCH_COLOR,
                            borderStyle: 'dashed',
                            left: previewX,
                            top: midY,
                            transform: 'translate(-50%, -50%)'
                          }}
                        />
                      </span>
                      <span className="flex min-w-0 flex-1 items-center gap-2">
                        <span
                          className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px]"
                          style={{
                            borderColor: `${NEW_BRANCH_COLOR}55`,
                            backgroundColor: `${NEW_BRANCH_COLOR}1A`,
                            color: '#fce7f3'
                          }}
                        >
                          <GitBranch className="size-3 shrink-0" />
                          <span className="min-w-0 truncate">{branchName || 'new-branch'}</span>
                        </span>
                      </span>
                      <Text className="w-20 shrink-0 text-xs text-neutral-600">
                        preview
                      </Text>
                    </div>
                  ) : null}
                  <div
                    ref={(node) => {
                      if (node) {
                        rowRefs.current.set(row.commit.hash, node);
                      } else {
                        rowRefs.current.delete(row.commit.hash);
                      }
                    }}
                    className={cn(
                      'flex w-full min-w-0 items-center gap-3 px-3 transition',
                      isTarget && 'bg-neutral-800/70',
                      isTarget && isZooming && 'scale-[1.015]'
                    )}
                    style={{ height: GRAPH_ROW_HEIGHT, transformOrigin: 'left center' }}
                  >
                    <span
                      className="relative shrink-0"
                      style={{ width: graphCellWidth, height: GRAPH_ROW_HEIGHT }}
                    >
                      <svg
                        aria-hidden="true"
                        width={graphCellWidth}
                        height={GRAPH_ROW_HEIGHT}
                        className="pointer-events-none absolute inset-0 overflow-visible"
                      >
                        <g transform={`translate(${graphOffsetX} 0)`}>
                          {isTarget ? (
                            <path
                              d={gitGraphPreviewEdgePath({
                                childBottomY: -midY + PREVIEW_DOT_RADIUS,
                                childColumn: previewColumn,
                                parentColumn: row.column,
                                parentTopY: midY - PREVIEW_DOT_RADIUS
                              })}
                              fill="none"
                              stroke={NEW_BRANCH_COLOR}
                              strokeDasharray="3 4"
                              strokeLinecap="round"
                              strokeOpacity={0.92}
                              strokeWidth={2.5}
                            />
                          ) : null}
                          {row.segments.map((segment, index) => (
                            <path
                              key={index}
                              d={gitGraphSegmentPath(segment)}
                              fill="none"
                              stroke={segment.color}
                              strokeLinecap="round"
                              strokeDasharray={segment.isSynthetic ? '3 3' : undefined}
                              strokeOpacity={isTarget ? 1 : 0.58}
                              strokeWidth={isTarget ? 2.5 : 2}
                            />
                          ))}
                        </g>
                      </svg>
                      <span
                        className={cn(
                          'absolute size-2.5 rounded-full border-2 border-neutral-950 transition',
                          isTarget && 'size-3.5 ring-4 ring-sky-400/20'
                        )}
                        style={{
                          backgroundColor: isTarget ? '#0a0a0a' : row.color,
                          borderColor: isTarget ? row.color : '#0a0a0a',
                          borderWidth: isTarget ? 3 : 2,
                          left: baseX,
                          top: midY,
                          transform: 'translate(-50%, -50%)'
                        }}
                      />
                    </span>
                    <span className="flex min-w-0 flex-1 items-center gap-2">
                      <Text
                        className={cn(
                          'min-w-0 truncate text-sm',
                          isTarget ? 'font-semibold text-neutral-100' : 'text-neutral-400'
                        )}
                      >
                        {row.commit.subject}
                      </Text>
                    </span>
                    <Text className="w-20 shrink-0 text-xs text-neutral-600">
                      {row.commit.date}
                    </Text>
                  </div>
                </Fragment>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
