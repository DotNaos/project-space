import { useEffect, useMemo, useRef, useState } from 'react';
import { GitCommitHorizontal, GitPullRequest, PanelLeftOpen, RefreshCw, Tag } from 'lucide-react';
import { Button, Chip, Surface, Text, Tooltip } from '@/app/dotnaos-ui';
import { projectSpaceClient } from '@/api/project-space-client';
import { cn } from '@/lib/utils';
import type {
  ConnectorOverviewResult,
  GitHubCatalogRepository,
  GitHistoryCommit,
  GitHubBranchRecord,
  GitHubPullRequestRecord,
  ProjectSpaceRecord
} from '@/shared/project-space-api';
import { usePaneResize } from '../hooks/use-pane-resize';
import type { MachineDetailTab } from '../hooks/use-project-desktop';
import { GitBranchDeleteDialog } from './git-branch-delete-dialog';
import {
  buildGitBranchOptions,
  type GitBranchOption,
  GitBranchSidebar,
  GitCommitDetailsPane
} from './git-graph-browser';
import {
  canonicalRepositoryName,
  defaultRepositoryBranch,
  findProjectBranchUsages
} from './project-branch-usage';
import { PaneResizeHandle } from './pane-resize-handle';

const COMMIT_LIMIT = 300;
const LANE_WIDTH = 14;
const ROW_HEIGHT = 32;

const graphPalette = [
  '#0085d9',
  '#d9008f',
  '#00d90a',
  '#d98500',
  '#a300d9',
  '#ff4d4d',
  '#00d9cc',
  '#e138e8',
  '#f5c400',
  '#6d8cff',
  '#00b36b',
  '#ff6f00',
  '#b967ff',
  '#ff3d7f',
  '#33d6ff',
  '#9ad900'
];

type GraphCommit = GitHistoryCommit;

interface RowSegment {
  color: string;
  fromColumn: number;
  half: 'top' | 'bottom' | 'full';
  isSynthetic?: boolean;
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

function layoutGraph(
  commits: GraphCommit[],
  branchColorByTipHash: Map<string, string>
): { maxLanes: number; rows: GraphRow[] } {
  const lanes: Array<Lane | null> = [];
  const rows: GraphRow[] = [];
  let colorCursor = 0;
  let maxLanes = 1;

  function takeColor() {
    const color = graphPalette[colorCursor % graphPalette.length];
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
      color = branchColorByTipHash.get(commit.hash) ?? takeColor();
      lanes[column] = { color, hash: commit.hash };
    }

    const segments: RowSegment[] = [];
    const isNewLaneAtCommit = waiting.length === 0;

    lanes.forEach((lane, index) => {
      if (!lane) {
        return;
      }

      if (lane.hash === commit.hash) {
        if (isNewLaneAtCommit && index === column) {
          return;
        }

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
      const parentColor = branchColorByTipHash.get(parent) ?? takeColor();
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

function addMergedPullRequestSegments({
  branchColorByLabel,
  branches,
  pullRequests,
  rows
}: {
  branchColorByLabel: Map<string, string>;
  branches: GitBranchOption[];
  pullRequests: GitHubPullRequestRecord[];
  rows: GraphRow[];
}) {
  const nextRows = rows.map((row) => ({
    ...row,
    segments: [...row.segments]
  }));
  const rowByHash = new Map(nextRows.map((row, index) => [row.commit.hash, { index, row }]));

  for (const pullRequest of pullRequests) {
    if (pullRequest.state !== 'merged' || !pullRequest.headBranch || !pullRequest.mergeCommitHash) {
      continue;
    }

    const branch = branches.find((option) => option.label === pullRequest.headBranch);
    const branchTipHash = branch?.tip?.hash;
    const mergeHit = rowByHash.get(pullRequest.mergeCommitHash);
    const tipHit = branchTipHash ? rowByHash.get(branchTipHash) : undefined;

    if (!branch || !branchTipHash || !mergeHit || !tipHit || mergeHit.index >= tipHit.index) {
      continue;
    }

    if (mergeHit.row.commit.parents.includes(branchTipHash)) {
      continue;
    }

    const color = branchColorByLabel.get(branch.label) ?? branch.color ?? mergeHit.row.color;
    const branchColumn = tipHit.row.column;
    const mergeColumn = mergeHit.row.column;

    mergeHit.row.segments.push({
      color,
      fromColumn: mergeColumn,
      half: 'bottom',
      isSynthetic: true,
      toColumn: branchColumn
    });

    for (let index = mergeHit.index + 1; index < tipHit.index; index += 1) {
      nextRows[index]?.segments.push({
        color,
        fromColumn: branchColumn,
        half: 'full',
        isSynthetic: true,
        toColumn: branchColumn
      });
    }

    tipHit.row.segments.push({
      color,
      fromColumn: branchColumn,
      half: 'top',
      isSynthetic: true,
      toColumn: branchColumn
    });
  }

  return nextRows;
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

function pullRequestNumber(subject: string) {
  const mergeMatch = /^Merge pull request #(\d+)\b/.exec(subject);

  if (mergeMatch) {
    return Number(mergeMatch[1]);
  }

  const squashMatch = /\(#(\d+)\)\s*$/.exec(subject);

  return squashMatch ? Number(squashMatch[1]) : undefined;
}

function cleanBranchRef(ref: string) {
  const cleanRef = ref.replace(/^HEAD -> /, '').trim();

  if (!cleanRef || cleanRef === 'HEAD' || cleanRef === 'origin/HEAD' || cleanRef.startsWith('tag: ')) {
    return null;
  }

  return cleanRef.startsWith('origin/') ? cleanRef.slice('origin/'.length) : cleanRef;
}

function commitBranchLabels(commit: GraphCommit) {
  return Array.from(
    new Set(commit.refs.map(cleanBranchRef).filter((label): label is string => Boolean(label)))
  );
}

function withoutDeletedBranchRefs(commits: GraphCommit[], deletedBranchLabels: Set<string>) {
  if (deletedBranchLabels.size === 0) {
    return commits;
  }

  return commits.map((commit) => ({
    ...commit,
    refs: commit.refs.filter((ref) => {
      const branch = cleanBranchRef(ref);

      return !branch || !deletedBranchLabels.has(branch);
    })
  }));
}

function colorForBranchIndex(index: number) {
  return graphPalette[index % graphPalette.length];
}

function CommitDotTooltip({
  branchColors,
  branches,
  color,
  commit,
  isBranchHighlighted,
  isBranchMuted,
  isMerge,
  isSelected,
  isPullRequest
}: {
  branchColors: Map<string, string>;
  branches: string[];
  color: string;
  commit: GraphCommit;
  isBranchHighlighted: boolean;
  isBranchMuted: boolean;
  isMerge: boolean;
  isSelected: boolean;
  isPullRequest: boolean;
}) {
  const dotScale = isSelected ? 1.18 : isBranchHighlighted ? 1.12 : undefined;

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
            'block rounded-full border-2 transition-all duration-150 ease-out group-hover:scale-110',
            isMerge ? 'size-3' : 'size-2.5'
          )}
          style={{
            backgroundColor: isPullRequest ? '#e5e7eb' : color,
            borderColor: isPullRequest ? color : '#0a0a0a',
            filter: isMerge && !isPullRequest ? 'brightness(1.35) saturate(1.65)' : undefined,
            opacity: isBranchMuted ? 0.32 : 1,
            transform: dotScale ? `scale(${dotScale})` : undefined
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
        {branches.length > 0 ? (
          <span className="flex min-w-0 flex-wrap gap-1 pt-1">
            {branches.map((branch) => (
              <Chip
                key={branch}
                size="sm"
                variant="secondary"
                className="max-w-full gap-1 rounded-full border bg-neutral-900/80 px-1.5 py-0.5"
                style={{
                  borderColor: branchColors.get(branch) ?? color,
                  color: branchColors.get(branch) ?? color
                }}
              >
                <GitCommitHorizontal className="size-3 shrink-0" />
                <span className="truncate">{branch}</span>
              </Chip>
            ))}
          </span>
        ) : null}
      </Tooltip.Content>
    </Tooltip>
  );
}

export function GitGraphPanel({
  connectorOverview,
  githubBranches = [],
  onOpenMachine,
  onRefreshRepositoryDetails,
  project,
  projects = [],
  pullRequests = [],
  repository,
  repositoryFullName,
  targetPath
}: {
  connectorOverview?: ConnectorOverviewResult;
  githubBranches?: GitHubBranchRecord[];
  onOpenMachine?(machineId: string, tab?: MachineDetailTab): void;
  onRefreshRepositoryDetails?(): Promise<void> | void;
  project?: ProjectSpaceRecord;
  projects?: ProjectSpaceRecord[];
  pullRequests?: GitHubPullRequestRecord[];
  repository?: GitHubCatalogRepository;
  repositoryFullName?: string;
  targetPath: string;
}) {
  const [allCommits, setAllCommits] = useState<GraphCommit[]>([]);
  const [commits, setCommits] = useState<GraphCommit[]>([]);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isBranchFilterActive, setIsBranchFilterActive] = useState(false);
  const [selectedHash, setSelectedHash] = useState('');
  const [selectedBranchLabel, setSelectedBranchLabel] = useState('');
  const [visibleBranchLabels, setVisibleBranchLabels] = useState<Set<string>>(() => new Set());
  const [hoveredBranch, setHoveredBranch] = useState<GitBranchOption | null>(null);
  const [deleteBranch, setDeleteBranch] = useState<GitBranchOption | null>(null);
  const [deletedBranchLabels, setDeletedBranchLabels] = useState<Set<string>>(() => new Set());
  const [deleteMessage, setDeleteMessage] = useState('');
  const [isDeletingBranch, setIsDeletingBranch] = useState(false);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const sidebarPane = usePaneResize({ axis: 'x', initialSize: 208, maxSize: 420, minSize: 150 });
  const detailPane = usePaneResize({
    axis: 'y',
    initialSize: 300,
    invert: true,
    maxSize: 640,
    minSize: 130
  });
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isDetailCollapsed, setIsDetailCollapsed] = useState(false);

  async function refresh() {
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
      setSelectedHash((previousHash) =>
        allResult.commits.some((commit) => commit.hash === previousHash)
          ? previousHash
          : allResult.commits[0]?.hash ?? ''
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
    setSelectedBranchLabel('');
    setDeletedBranchLabels(new Set());
    void refresh();
  }, [repositoryFullName, targetPath]);

  const branchSourceCommits = useMemo(
    () => withoutDeletedBranchRefs(allCommits.length > 0 ? allCommits : commits, deletedBranchLabels),
    [allCommits, commits, deletedBranchLabels]
  );
  const graphCommits = useMemo(
    () => withoutDeletedBranchRefs(commits, deletedBranchLabels),
    [commits, deletedBranchLabels]
  );
  const branchOptions = useMemo(
    () => buildGitBranchOptions(branchSourceCommits, githubBranches, pullRequests),
    [branchSourceCommits, githubBranches, pullRequests]
  );
  const branchColorByLabel = useMemo(() => {
    const colors = new Map<string, string>();

    branchOptions.forEach((branch, index) => {
      colors.set(branch.label, colorForBranchIndex(index));
    });

    return colors;
  }, [branchOptions]);
  const branchColorByTipHash = useMemo(() => {
    const colors = new Map<string, string>();

    for (const branch of branchOptions) {
      if (branch.tip) {
        colors.set(branch.tip.hash, branchColorByLabel.get(branch.label) ?? colorForBranchIndex(0));
      }
    }

    return colors;
  }, [branchColorByLabel, branchOptions]);
  const { maxLanes, rows } = useMemo(() => {
    const graph = layoutGraph(graphCommits, branchColorByTipHash);

    return {
      ...graph,
      rows: addMergedPullRequestSegments({
        branchColorByLabel,
        branches: branchOptions,
        pullRequests,
        rows: graph.rows
      })
    };
  }, [branchColorByLabel, branchColorByTipHash, branchOptions, graphCommits, pullRequests]);
  const pullRequestByNumber = useMemo(() => {
    const map = new Map<number, GitHubPullRequestRecord>();

    pullRequests.forEach((pullRequest) => {
      map.set(pullRequest.number, pullRequest);
    });

    return map;
  }, [pullRequests]);
  const pullRequestByMergeCommitHash = useMemo(() => {
    const map = new Map<string, GitHubPullRequestRecord>();

    pullRequests.forEach((pullRequest) => {
      if (pullRequest.mergeCommitHash) {
        map.set(pullRequest.mergeCommitHash, pullRequest);
      }
    });

    return map;
  }, [pullRequests]);
  const coloredBranchOptions = useMemo(
    () =>
      branchOptions.map((branch) => ({
        ...branch,
        color: branchColorByLabel.get(branch.label)
      })),
    [branchColorByLabel, branchOptions]
  );
  const branchLabelKey = useMemo(
    () => coloredBranchOptions.map((branch) => branch.label).join('\0'),
    [coloredBranchOptions]
  );
  const visibleBranchKey = useMemo(
    () => Array.from(visibleBranchLabels).sort().join('\0'),
    [visibleBranchLabels]
  );

  useEffect(() => {
    const labels = coloredBranchOptions.map((branch) => branch.label);

    setVisibleBranchLabels((previousLabels) => {
      const nextLabels = new Set(
        Array.from(previousLabels).filter((label) => labels.includes(label))
      );

      if (previousLabels.size === 0 || nextLabels.size === 0) {
        labels.forEach((label) => nextLabels.add(label));
      }

      return nextLabels;
    });
  }, [branchLabelKey, coloredBranchOptions]);

  useEffect(() => {
    let isCanceled = false;

    async function applyBranchFilter() {
      if (!targetPath) {
        setCommits([]);
        return;
      }

      if (!isBranchFilterActive || visibleBranchLabels.size === coloredBranchOptions.length) {
        setCommits(allCommits);
        setSelectedHash((previousHash) =>
          allCommits.some((commit) => commit.hash === previousHash)
            ? previousHash
            : allCommits[0]?.hash ?? ''
        );
        return;
      }

      const selectedBranches = coloredBranchOptions.filter((branch) =>
        visibleBranchLabels.has(branch.label)
      );

      if (selectedBranches.length === 0) {
        setCommits([]);
        setSelectedHash('');
        return;
      }

      setIsLoading(true);

      try {
        const branchHistories = await Promise.all(
          selectedBranches.map((branch) =>
            projectSpaceClient.getGitHistory({
              cwd: targetPath,
              limit: COMMIT_LIMIT,
              ref: branch.ref,
              repositoryFullName
            })
          )
        );

        if (isCanceled) {
          return;
        }

        const commitByHash = new Map<string, GraphCommit>();

        for (const history of branchHistories) {
          for (const commit of history.commits) {
            commitByHash.set(commit.hash, commit);
          }
        }

        const orderedCommits = allCommits
          .filter((commit) => commitByHash.has(commit.hash))
          .map((commit) => commitByHash.get(commit.hash) ?? commit);

        for (const commit of commitByHash.values()) {
          if (!orderedCommits.some((orderedCommit) => orderedCommit.hash === commit.hash)) {
            orderedCommits.push(commit);
          }
        }

        setCommits(orderedCommits);
        setSelectedHash((previousHash) =>
          orderedCommits.some((commit) => commit.hash === previousHash)
            ? previousHash
            : orderedCommits[0]?.hash ?? ''
        );
      } catch (requestError) {
        if (!isCanceled) {
          setError(
            requestError instanceof Error
              ? requestError.message
              : 'Could not filter the git history.'
          );
        }
      } finally {
        if (!isCanceled) {
          setIsLoading(false);
        }
      }
    }

    void applyBranchFilter();

    return () => {
      isCanceled = true;
    };
  }, [
    allCommits,
    coloredBranchOptions,
    isBranchFilterActive,
    repositoryFullName,
    targetPath,
    visibleBranchKey,
    visibleBranchLabels
  ]);
  const graphWidth = maxLanes * LANE_WIDTH;
  const selectedCommit = commits.find((commit) => commit.hash === selectedHash) ?? commits[0];
  const activeBranchLabel = useMemo(() => {
    if (!selectedCommit) {
      return '';
    }

    const selectedBranch = coloredBranchOptions.find(
      (branch) => branch.label === selectedBranchLabel && branch.tip?.hash === selectedCommit.hash
    );

    if (selectedBranch) {
      return selectedBranch.label;
    }

    const selectedCommitBranches = commitBranchLabels(selectedCommit);

    return (
      coloredBranchOptions.find(
        (branch) =>
          branch.tip?.hash === selectedCommit.hash &&
          (selectedCommitBranches.length === 0 || selectedCommitBranches.includes(branch.label))
      )?.label ??
      coloredBranchOptions.find((branch) => selectedCommitBranches.includes(branch.label))?.label ??
      ''
    );
  }, [coloredBranchOptions, selectedBranchLabel, selectedCommit]);
  const highlightedBranchColor = hoveredBranch
    ? branchColorByLabel.get(hoveredBranch.label)
    : undefined;
  const deleteBranchUsages = useMemo(() => {
    if (!deleteBranch || !connectorOverview || !project) {
      return [];
    }

    return findProjectBranchUsages({
      branchName: deleteBranch.label,
      connectorOverview,
      defaultBranch: defaultRepositoryBranch(project, repository),
      projects,
      repositoryName: canonicalRepositoryName(project, repository)
    });
  }, [connectorOverview, deleteBranch, project, projects, repository]);

  function selectCommit(
    hash: string,
    options: { branchLabel?: string; scroll?: boolean } = {}
  ) {
    setSelectedHash(hash);
    setSelectedBranchLabel(options.branchLabel ?? '');

    if (options.scroll) {
      requestAnimationFrame(() => {
        rowRefs.current.get(hash)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
    }
  }

  function jumpToBranchTip(branch: GitBranchOption) {
    if (!branch.tip) {
      return;
    }

    selectCommit(branch.tip.hash, { branchLabel: branch.label, scroll: true });
  }

  function toggleBranchVisibility(branch: GitBranchOption) {
    setVisibleBranchLabels((previousLabels) => {
      const nextLabels = new Set(previousLabels);

      if (nextLabels.has(branch.label)) {
        nextLabels.delete(branch.label);
      } else {
        nextLabels.add(branch.label);
      }

      return nextLabels;
    });
  }

  async function deleteRemoteBranch() {
    if (!deleteBranch || !repositoryFullName) {
      return;
    }

    setIsDeletingBranch(true);
    setDeleteMessage('');

    try {
      const result = await projectSpaceClient.deleteGitHubBranch({
        fullName: repositoryFullName,
        name: deleteBranch.label
      });

      setDeleteMessage(result.message ?? '');

      if (result.status === 'connected') {
        setDeletedBranchLabels((previousLabels) => {
          const nextLabels = new Set(previousLabels);
          nextLabels.add(deleteBranch.label);
          return nextLabels;
        });
        setVisibleBranchLabels((previousLabels) => {
          const nextLabels = new Set(previousLabels);
          nextLabels.delete(deleteBranch.label);
          return nextLabels;
        });
        if (selectedBranchLabel === deleteBranch.label) {
          setSelectedBranchLabel('');
        }
        await onRefreshRepositoryDetails?.();
        setDeleteBranch(null);
      }
    } catch (error) {
      setDeleteMessage(error instanceof Error ? error.message : 'Could not delete branch.');
    } finally {
      setIsDeletingBranch(false);
    }
  }

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
              ? `${rows.length}${rows.length >= COMMIT_LIMIT ? '+' : ''} commits, all branches`
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
        <div
          className="grid min-h-0 flex-1 overflow-hidden"
          style={{
            gridTemplateColumns: `${isSidebarCollapsed ? 44 : sidebarPane.size}px minmax(0,1fr)`
          }}
        >
          <div className="relative min-h-0 min-w-0">
            {isSidebarCollapsed ? (
              <div className="flex h-full flex-col items-center gap-2 border-r border-neutral-800/70 py-2">
                <Button
                  aria-label="Expand branches"
                  isIconOnly
                  size="sm"
                  variant="ghost"
                  onPress={() => setIsSidebarCollapsed(false)}
                >
                  <PanelLeftOpen className="size-3.5" />
                </Button>
              </div>
            ) : (
              <>
                <GitBranchSidebar
                  activeBranchLabel={activeBranchLabel}
                  branches={coloredBranchOptions}
                  isFilterActive={isBranchFilterActive}
                  isLoading={isLoading}
                  onCollapse={() => setIsSidebarCollapsed(true)}
                  onDeleteBranch={(branch) => {
                    setDeleteBranch(branch);
                    setDeleteMessage('');
                  }}
                  onHoverBranch={setHoveredBranch}
                  onSelectBranch={jumpToBranchTip}
                  onToggleBranch={toggleBranchVisibility}
                  onToggleFilter={() => setIsBranchFilterActive((current) => !current)}
                  visibleBranchLabels={visibleBranchLabels}
                />
                <PaneResizeHandle axis="x" onStart={sidebarPane.startResize} />
              </>
            )}
          </div>
          <div className="flex min-h-0 min-w-0 flex-col">
            <div data-testid="git-graph-scroll" className="min-h-0 min-w-0 flex-1 overflow-auto">
              <div className="min-w-fit py-1">
	                {rows.map((row) => {
	                  const isMerge = row.commit.parents.length > 1;
	                  const isSelected = row.commit.hash === selectedCommit?.hash;
	                  const isBranchHighlighted = highlightedBranchColor === row.color;
	                  const isBranchMuted = Boolean(highlightedBranchColor && !isBranchHighlighted);
	                  const commitPullRequest =
                    pullRequestByMergeCommitHash.get(row.commit.hash) ??
                    (() => {
                      const number = pullRequestNumber(row.commit.subject);

                      return number ? pullRequestByNumber.get(number) : undefined;
                    })();
                  const prLabel = commitPullRequest
                    ? commitPullRequest.state === 'merged'
                      ? `merged #${commitPullRequest.number}`
                      : `PR #${commitPullRequest.number}`
                    : pullRequestLabel(row.commit.subject);

                  return (
                    <div
                      key={row.commit.hash}
                      ref={(node) => {
                        if (node) {
                          rowRefs.current.set(row.commit.hash, node);
                        } else {
                          rowRefs.current.delete(row.commit.hash);
                        }
                      }}
                      className={cn(
                        'group flex min-w-0 cursor-pointer items-center gap-3 px-3 outline-none transition hover:bg-neutral-900/50 focus-visible:bg-neutral-900/70',
                        isSelected && 'bg-neutral-800/70 hover:bg-neutral-800/70'
                      )}
                      onClick={() => selectCommit(row.commit.hash)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          selectCommit(row.commit.hash);
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
                          {row.segments.map((segment, index) => {
                            const isSegmentHighlighted =
                              highlightedBranchColor === segment.color;

	                            return (
	                              <path
	                                key={index}
	                                d={segmentPath(segment)}
	                                fill="none"
	                                stroke={segment.color}
		                                strokeLinecap="round"
		                                strokeDasharray={segment.isSynthetic ? '3 3' : undefined}
		                                strokeOpacity={
	                                  highlightedBranchColor
	                                    ? isSegmentHighlighted
	                                      ? 1
	                                      : 0.28
	                                    : 1
	                                }
	                                strokeWidth={isSegmentHighlighted ? 3 : 2}
	                                className="transition-all duration-150 ease-out"
	                              />
	                            );
	                          })}
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
                            branchColors={branchColorByLabel}
                            branches={commitBranchLabels(row.commit)}
	                            color={row.color}
	                            commit={row.commit}
	                            isBranchHighlighted={isBranchHighlighted}
	                            isBranchMuted={isBranchMuted}
	                            isMerge={isMerge}
                            isSelected={isSelected}
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
                            className={cn(
                              'gap-1 rounded-full border px-1.5 py-0.5',
                              commitPullRequest?.state === 'merged'
                                ? 'border-violet-400/25 bg-violet-400/10 text-violet-200'
                                : 'border-sky-400/25 bg-sky-400/10 text-sky-200'
                            )}
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
          <div
            className="relative flex min-h-0 shrink-0 flex-col border-t border-neutral-800/70"
            style={{ height: isDetailCollapsed ? undefined : detailPane.size }}
          >
            {isDetailCollapsed ? null : (
              <PaneResizeHandle axis="y" onStart={detailPane.startResize} />
            )}
            <GitCommitDetailsPane
              commit={selectedCommit}
              isCollapsed={isDetailCollapsed}
              onToggleCollapse={() => setIsDetailCollapsed((current) => !current)}
              targetPath={targetPath}
            />
          </div>
          </div>
        </div>
      )}
      {deleteBranch ? (
        <GitBranchDeleteDialog
          branch={deleteBranch}
          isDeleting={isDeletingBranch}
          message={deleteMessage}
          usages={deleteBranchUsages}
          onClose={() => setDeleteBranch(null)}
          onDelete={() => void deleteRemoteBranch()}
          onOpenMachine={(machineId) => {
            setDeleteBranch(null);
            onOpenMachine?.(machineId, 'projects');
          }}
        />
      ) : null}
    </Surface>
  );
}
