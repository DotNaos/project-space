import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  GitCompareArrows,
  History
} from 'lucide-react';
import { Button, Chip, Text } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import type { GitHubBranchComparisonResult } from '@/shared/project-space-api';
import type { BranchHeadComparisonLoadState } from '../hooks/use-branch-head-comparison';
import {
  branchHeadComparisonPresentation,
  comparisonHasRenderableGraph
} from './branch-head-comparison-model';
import {
  colorForBranchIndex,
  GRAPH_LANE_WIDTH,
  GRAPH_ROW_HEIGHT,
  gitGraphLaneX,
  gitGraphSegmentPath,
  layoutGitGraph
} from './git-graph-layout';

function shortSha(value: string) {
  return value.slice(0, 7);
}

function compactBranchName(value: string) {
  if (value.length <= 32) return value;
  const issuePrefix = value.match(/^issue-\d+/i)?.[0];
  const suffix = value.slice(-16);
  return `${issuePrefix ?? value.slice(0, 12)}…${suffix}`;
}

function GraphGap() {
  return (
    <div
      data-testid="branch-head-graph-gap"
      className="grid min-h-7 grid-cols-[3rem_minmax(0,1fr)] items-center gap-2 text-neutral-600"
    >
      <span className="text-center font-mono text-sm tracking-[0.3em]">•••</span>
      <span className="flex min-w-0 items-center gap-2">
        <span className="h-px min-w-4 flex-1 bg-neutral-800" />
        <Text className="shrink-0 text-[10px]">history collapsed</Text>
        <span className="h-px min-w-4 flex-1 bg-neutral-800" />
      </span>
    </div>
  );
}

function TipLabels({
  commitHash,
  result
}: {
  commitHash: string;
  result: GitHubBranchComparisonResult & {
    defaultBranch: NonNullable<GitHubBranchComparisonResult['defaultBranch']>;
    head: NonNullable<GitHubBranchComparisonResult['head']>;
  };
}) {
  const isHead = commitHash === result.head.sha;
  const isDefault = commitHash === result.defaultBranch.sha;

  if (!isHead && !isDefault) return null;

  return (
    <span className="flex min-w-0 flex-wrap gap-1">
      {isHead ? (
        <Chip
          size="sm"
          variant="secondary"
          title={result.head.name}
          className="max-w-full rounded border border-purple-400/30 bg-purple-500/10 px-1.5 py-0.5 text-purple-200"
        >
          <span className="truncate">{compactBranchName(result.head.name)}</span>
        </Chip>
      ) : null}
      {isDefault ? (
        <Chip
          size="sm"
          variant="secondary"
          className="max-w-full rounded border border-neutral-700 bg-neutral-900 px-1.5 py-0.5 text-neutral-300"
        >
          <span className="truncate">{result.defaultBranch.name}</span>
        </Chip>
      ) : null}
    </span>
  );
}

function ComparisonGraph({
  result
}: {
  result: GitHubBranchComparisonResult & {
    defaultBranch: NonNullable<GitHubBranchComparisonResult['defaultBranch']>;
    head: NonNullable<GitHubBranchComparisonResult['head']>;
  };
}) {
  const headColor = colorForBranchIndex(4);
  const defaultColor = colorForBranchIndex(0);
  const graph = useMemo(
    () => layoutGitGraph(
      result.commits,
      new Map([
        [result.defaultBranch.sha, defaultColor],
        [result.head.sha, headColor]
      ])
    ),
    [defaultColor, headColor, result.commits, result.defaultBranch.sha, result.head.sha]
  );
  const graphWidth = Math.max(3 * GRAPH_LANE_WIDTH, graph.maxLanes * GRAPH_LANE_WIDTH);
  const mergeBaseIndex = result.mergeBaseSha
    ? graph.rows.findIndex((row) => row.commit.hash === result.mergeBaseSha)
    : -1;

  return (
    <div className="grid min-w-0 gap-0.5 border-t border-neutral-800/70 pt-1.5">
      {graph.rows.map((row, index) => (
        <div key={row.commit.hash}>
          {result.truncated && index === mergeBaseIndex ? <GraphGap /> : null}
          <div
            className="grid min-h-8 min-w-0 items-center gap-2"
            style={{ gridTemplateColumns: `${graphWidth + 8}px minmax(0, 1fr)` }}
          >
            <svg
              aria-hidden="true"
              className="overflow-visible"
              height={GRAPH_ROW_HEIGHT}
              viewBox={`0 0 ${graphWidth + 8} ${GRAPH_ROW_HEIGHT}`}
              width={graphWidth + 8}
            >
              <g transform="translate(4 0)">
                {row.segments.map((segment, segmentIndex) => (
                  <path
                    key={`${segmentIndex}-${segment.fromColumn}-${segment.toColumn}-${segment.half}`}
                    d={gitGraphSegmentPath(segment)}
                    fill="none"
                    opacity={0.82}
                    stroke={segment.color}
                    strokeLinecap="round"
                    strokeWidth={1.7}
                  />
                ))}
                <circle
                  cx={gitGraphLaneX(row.column)}
                  cy={GRAPH_ROW_HEIGHT / 2}
                  fill={row.commit.hash === result.head.sha ? '#0a0a0a' : row.color}
                  r={row.commit.parents.length > 1 ? 5 : 4}
                  stroke={row.color}
                  strokeWidth={2}
                />
              </g>
            </svg>
            <div className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1">
                <TipLabels commitHash={row.commit.hash} result={result} />
                <Text className="block truncate text-[11px] leading-4 text-neutral-400">
                  {row.commit.subject || 'Commit message unavailable'}
                </Text>
              </span>
              <Text className="shrink-0 font-mono text-[10px] text-neutral-600">
                {shortSha(row.commit.hash)}
              </Text>
            </div>
          </div>
        </div>
      ))}
      {result.truncated && mergeBaseIndex < 0 ? <GraphGap /> : null}
    </div>
  );
}

function FailureState({ result }: { result: GitHubBranchComparisonResult }) {
  return (
    <div
      role={result.freshness === 'stale' ? 'status' : 'alert'}
      className={cn(
        'flex min-w-0 items-start gap-2 rounded-md px-2 py-1.5 text-xs',
        result.freshness === 'stale'
          ? 'bg-amber-500/10 text-amber-200'
          : 'bg-neutral-900/70 text-neutral-500'
      )}
    >
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0">
        <Text className="block">{result.message ?? 'Branch position is unavailable.'}</Text>
        {result.checkedAt ? (
          <Text className="mt-0.5 block text-[10px] opacity-70">
            Checked {new Date(result.checkedAt).toLocaleString()}
          </Text>
        ) : null}
      </span>
    </div>
  );
}

export function BranchHeadGraphPreview({
  comparison,
  onOpenHistory
}: {
  comparison: BranchHeadComparisonLoadState;
  onOpenHistory(input: { defaultBranch: string; headBranch: string }): void;
}) {
  const [expanded, setExpanded] = useState(true);
  const result = comparison.state === 'ready' ? comparison.result : undefined;

  useEffect(() => {
    setExpanded(true);
  }, [result?.head?.sha]);

  if (comparison.state === 'idle') return null;
  if (comparison.state === 'loading') {
    return (
      <div
        aria-live="polite"
        role="status"
        className="flex items-center gap-2 rounded-md bg-neutral-900/60 px-2 py-1.5"
      >
        <GitCompareArrows className="size-3.5 text-neutral-500" />
        <Text className="text-xs text-neutral-500">Checking branch position…</Text>
      </div>
    );
  }
  if (!result || !comparisonHasRenderableGraph(result)) {
    return result ? <FailureState result={result} /> : null;
  }

  const presentation = branchHeadComparisonPresentation({
    aheadBy: result.aheadBy,
    behindBy: result.behindBy,
    state: result.state
  });
  const StatusIcon = presentation.actionRequired ? AlertTriangle : CheckCircle2;

  return (
    <div className="grid min-w-0 gap-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <StatusIcon
          className={cn(
            'size-3.5 shrink-0',
            presentation.tone === 'warning' ? 'text-amber-300' : 'text-emerald-300'
          )}
        />
        <Text
          className={cn(
            'min-w-[12rem] flex-1 text-xs font-medium',
            presentation.tone === 'warning' ? 'text-amber-200' : 'text-emerald-200'
          )}
        >
          {presentation.label}
        </Text>
        <Button
          aria-expanded={expanded}
          aria-label={expanded ? 'Collapse branch position graph' : 'Expand branch position graph'}
          isIconOnly
          size="sm"
          variant="ghost"
          className="size-7 min-h-7"
          onPress={() => setExpanded((value) => !value)}
        >
          <ChevronDown
            className={cn(
              'size-3.5 transition-transform duration-200 ease-out',
              expanded && 'rotate-180'
            )}
          />
        </Button>
      </div>
      <div
        aria-hidden={!expanded}
        className={cn(
          'grid min-w-0 transition-[grid-template-rows,opacity] duration-200 ease-out',
          expanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
        )}
      >
        <div className="min-h-0 min-w-0 overflow-hidden">
          <ComparisonGraph result={result} />
          <Button
            size="sm"
            variant="ghost"
            className="mt-1 w-full justify-between px-2 text-neutral-400"
            tabIndex={expanded ? 0 : -1}
            onPress={() => onOpenHistory({
              defaultBranch: result.defaultBranch.name,
              headBranch: result.head.name
            })}
          >
            <span className="flex items-center gap-2">
              <History className="size-3.5" />
              Open focused History
            </span>
            <GitCompareArrows className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
