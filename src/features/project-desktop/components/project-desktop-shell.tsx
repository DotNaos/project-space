import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ExplorerTarget,
  ProjectSpaceRecord,
  ProjectWorktreeRecord
} from '@/shared/electron-api';
import { Button } from '@/components/ui/button';
import { FileExplorer } from './file-explorer';
import { OpenTargetDropdown } from './open-target-dropdown';
import { SidebarViewTabs } from './sidebar-view-tabs';
import { SpacesDock } from './spaces-dock';
import { WorkflowExplorer } from './workflow-explorer';
import { useProjectDesktop } from '../hooks/use-project-desktop';

const SIDEBAR_WIDTH = 294;
const SIDEBAR_SWIPE_PREVIEW_LIMIT = 148;
const SIDEBAR_SWIPE_SNAP_THRESHOLD = 82;
const SIDEBAR_SWIPE_DIRECTION_THRESHOLD = 12;
const SIDEBAR_SWIPE_IDLE_RELEASE_MS = 220;
const SIDEBAR_SWIPE_TENSION_SPLIT = 0.58;
const SIDEBAR_SWIPE_TENSION_EXPONENT = 1.7;
const SIDEBAR_SWIPE_RELEASE_EXPONENT = 1.2;
const SIDEBAR_SWIPE_SPLIT_PROGRESS = 0.68;

interface SidebarContentProps {
  onSelectWorkspace(): void;
  project?: ProjectSpaceRecord;
  selectedExplorerTarget: ExplorerTarget;
  sidebarView: 'workspace' | 'files';
  worktrees: ProjectWorktreeRecord[];
  onSelectWorktree(worktreeId: string): void;
}

const SidebarContent = memo(function SidebarContent({
  onSelectWorkspace,
  project,
  selectedExplorerTarget,
  sidebarView,
  worktrees,
  onSelectWorktree
}: SidebarContentProps) {
  if (sidebarView === 'workspace') {
    return (
      <WorkflowExplorer
        onSelectWorkspace={onSelectWorkspace}
        project={project}
        selectedExplorerTarget={selectedExplorerTarget}
        worktrees={worktrees}
        onSelectWorktree={onSelectWorktree}
      />
    );
  }

  const rootPath =
    selectedExplorerTarget.kind === 'worktree'
      ? worktrees.find((entry) => entry.id === selectedExplorerTarget.worktreeId)?.path ??
        project?.rootPath
      : project?.rootPath;

  return <FileExplorer rootPath={rootPath} />;
});

export function ProjectDesktopShell() {
  const desktop = useProjectDesktop();
  const [previewItemId, setPreviewItemId] = useState('');
  const [previewWorktrees, setPreviewWorktrees] = useState<ProjectWorktreeRecord[]>([]);
  const [previewDirection, setPreviewDirection] = useState<-1 | 0 | 1>(0);
  const currentPanelRef = useRef<HTMLDivElement | null>(null);
  const previewPanelRef = useRef<HTMLDivElement | null>(null);
  const swipeState = useRef({
    idleTimeoutId: 0 as number | undefined,
    settleTimeoutId: 0 as number | undefined,
    animationFrameId: 0 as number | undefined,
    isGestureActive: false,
    isSettling: false,
    offset: 0,
    previewDirection: 0 as -1 | 0 | 1,
    previewItemId: ''
  });

  const activeNavigationIndex = useMemo(() => {
    const index = desktop.navigationItems.findIndex((entry) => entry.id === desktop.activeNavigationItemId);
    return index >= 0 ? index : 0;
  }, [desktop.activeNavigationItemId, desktop.navigationItems]);

  const previewItem = useMemo(() => {
    return desktop.navigationItems.find((entry) => entry.id === previewItemId);
  }, [desktop.navigationItems, previewItemId]);

  const previewSelection = useMemo(() => {
    return previewItem ? desktop.resolveNavigationSelection(previewItem.id) : null;
  }, [desktop, previewItem]);

  const previewProject = useMemo(() => {
    return previewSelection?.nextProjectId
      ? desktop.projects.find((entry) => entry.id === previewSelection.nextProjectId)
      : undefined;
  }, [desktop.projects, previewSelection]);

  useEffect(() => {
    const unsubscribe = window.projectSpace.onGestureScrollState((state) => {
      swipeState.current.isGestureActive = state === 'begin';

      if (state === 'end' && !swipeState.current.isSettling && swipeState.current.offset !== 0) {
        settleSwipe();
      }
    });

    return () => {
      unsubscribe();

      if (swipeState.current.idleTimeoutId) {
        window.clearTimeout(swipeState.current.idleTimeoutId);
      }

      if (swipeState.current.settleTimeoutId) {
        window.clearTimeout(swipeState.current.settleTimeoutId);
      }

      if (swipeState.current.animationFrameId) {
        window.cancelAnimationFrame(swipeState.current.animationFrameId);
      }
    };
  }, []);

  useEffect(() => {
    swipeState.current.previewDirection = previewDirection;
  }, [previewDirection]);

  useEffect(() => {
    swipeState.current.previewItemId = previewItemId;
  }, [previewItemId]);

  useEffect(() => {
    applySwipeTransform(
      swipeState.current.offset,
      swipeState.current.previewDirection,
      swipeState.current.isSettling
    );
  }, [previewDirection, previewItemId]);

  useEffect(() => {
    if (!previewProject || previewProject.kind !== 'workspace') {
      setPreviewWorktrees([]);
      return;
    }

    let canceled = false;

    void window.projectSpace.loadProjectWorktrees(previewProject.rootPath).then((nextWorktrees) => {
      if (canceled) {
        return;
      }

      setPreviewWorktrees(nextWorktrees);
    });

    return () => {
      canceled = true;
    };
  }, [previewProject]);

  function getRenderedSwipeOffset(offset: number, settling: boolean) {
    if (settling || offset === 0) {
      return offset;
    }

    const sign = Math.sign(offset);
    const normalized = Math.min(Math.abs(offset) / SIDEBAR_SWIPE_PREVIEW_LIMIT, 1);

    if (normalized <= SIDEBAR_SWIPE_TENSION_SPLIT) {
      const slowedProgress =
        Math.pow(
          normalized / SIDEBAR_SWIPE_TENSION_SPLIT,
          SIDEBAR_SWIPE_TENSION_EXPONENT
        ) * SIDEBAR_SWIPE_SPLIT_PROGRESS;

      return sign * SIDEBAR_SWIPE_PREVIEW_LIMIT * slowedProgress;
    }

    const remainingProgress =
      (normalized - SIDEBAR_SWIPE_TENSION_SPLIT) / (1 - SIDEBAR_SWIPE_TENSION_SPLIT);
    const releasedProgress =
      1 - Math.pow(1 - remainingProgress, SIDEBAR_SWIPE_RELEASE_EXPONENT);
    const totalProgress =
      SIDEBAR_SWIPE_SPLIT_PROGRESS +
      (1 - SIDEBAR_SWIPE_SPLIT_PROGRESS) * releasedProgress;

    return sign * SIDEBAR_SWIPE_PREVIEW_LIMIT * totalProgress;
  }

  function applySwipeTransform(offset: number, direction: -1 | 0 | 1, settling: boolean) {
    const transition = settling
      ? 'transform 220ms cubic-bezier(0.22, 1, 0.36, 1)'
      : 'none';
    const renderedOffset = getRenderedSwipeOffset(offset, settling);

    if (currentPanelRef.current) {
      currentPanelRef.current.style.transform = `translate3d(${-renderedOffset}px, 0, 0)`;
      currentPanelRef.current.style.transition = transition;
    }

    if (previewPanelRef.current) {
      previewPanelRef.current.style.left = direction > 0 ? '100%' : '-100%';
      previewPanelRef.current.style.transform = `translate3d(${-renderedOffset}px, 0, 0)`;
      previewPanelRef.current.style.transition = transition;
    }
  }

  function scheduleSwipeTransform() {
    if (swipeState.current.animationFrameId) {
      return;
    }

    swipeState.current.animationFrameId = window.requestAnimationFrame(() => {
      applySwipeTransform(
        swipeState.current.offset,
        swipeState.current.previewDirection,
        swipeState.current.isSettling
      );
      swipeState.current.animationFrameId = undefined;
    });
  }

  function resetSwipeState() {
    swipeState.current.offset = 0;
    swipeState.current.previewDirection = 0;
    swipeState.current.previewItemId = '';
    swipeState.current.isSettling = false;
    setPreviewDirection(0);
    setPreviewItemId('');
    setPreviewWorktrees([]);
    applySwipeTransform(0, 0, false);
  }

  function settleSwipe() {
    const renderedOffset = getRenderedSwipeOffset(swipeState.current.offset, false);
    const shouldSwitch =
      Math.abs(renderedOffset) >= SIDEBAR_SWIPE_SNAP_THRESHOLD &&
      Boolean(swipeState.current.previewItemId);
    const targetItemId = swipeState.current.previewItemId;

    swipeState.current.isSettling = true;
    swipeState.current.offset =
      shouldSwitch && swipeState.current.previewDirection !== 0
        ? swipeState.current.previewDirection * SIDEBAR_WIDTH
        : 0;

    scheduleSwipeTransform();

    swipeState.current.settleTimeoutId = window.setTimeout(() => {
      if (shouldSwitch && targetItemId) {
        desktop.selectNavigationItem(targetItemId, previewWorktrees);
      }

      resetSwipeState();
      swipeState.current.settleTimeoutId = undefined;
    }, 220);
  }

  function updatePreviewState(direction: -1 | 0 | 1) {
    if (direction === 0) {
      swipeState.current.previewItemId = '';
      swipeState.current.previewDirection = 0;
      setPreviewDirection(0);
      setPreviewItemId('');
      setPreviewWorktrees([]);
      return;
    }

    const nextIndex = activeNavigationIndex + direction;
    if (nextIndex < 0 || nextIndex >= desktop.navigationItems.length) {
      swipeState.current.previewItemId = '';
      swipeState.current.previewDirection = 0;
      setPreviewDirection(0);
      setPreviewItemId('');
      setPreviewWorktrees([]);
      return;
    }

    const nextItem = desktop.navigationItems[nextIndex];
    swipeState.current.previewDirection = direction;
    swipeState.current.previewItemId = nextItem?.id ?? '';
    setPreviewDirection(direction);
    setPreviewItemId(nextItem?.id ?? '');
  }

  return (
    <div className="h-screen overflow-hidden bg-app-canvas text-slate-100">
      <div className="grid h-full grid-cols-[294px_minmax(0,1fr)]">
        <aside
          onWheel={(event) => {
            if (desktop.navigationItems.length < 2) {
              return;
            }

            if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) {
              return;
            }

            event.preventDefault();

            if (swipeState.current.isSettling) {
              return;
            }

            if (swipeState.current.idleTimeoutId) {
              window.clearTimeout(swipeState.current.idleTimeoutId);
            }

            const atFirstItem = activeNavigationIndex <= 0;
            const atLastItem = activeNavigationIndex >= desktop.navigationItems.length - 1;
            const wantsPrevious = event.deltaX < 0;
            const wantsNext = event.deltaX > 0;
            const pushingPastEdge =
              (atFirstItem && wantsPrevious) || (atLastItem && wantsNext);
            const adjustedDeltaX = pushingPastEdge ? event.deltaX * 0.18 : event.deltaX;
            const nextOffset = Math.max(
              -SIDEBAR_SWIPE_PREVIEW_LIMIT,
              Math.min(SIDEBAR_SWIPE_PREVIEW_LIMIT, swipeState.current.offset + adjustedDeltaX)
            );
            const direction =
              nextOffset > SIDEBAR_SWIPE_DIRECTION_THRESHOLD
                ? 1
                : nextOffset < -SIDEBAR_SWIPE_DIRECTION_THRESHOLD
                  ? -1
                  : 0;

            swipeState.current.offset = nextOffset;
            updatePreviewState(direction);
            scheduleSwipeTransform();

            if (
              Math.abs(getRenderedSwipeOffset(nextOffset, false)) >= SIDEBAR_SWIPE_SNAP_THRESHOLD &&
              swipeState.current.previewItemId
            ) {
              settleSwipe();
              swipeState.current.idleTimeoutId = undefined;
              return;
            }

            if (!swipeState.current.isGestureActive) {
              swipeState.current.idleTimeoutId = window.setTimeout(() => {
                settleSwipe();
                swipeState.current.idleTimeoutId = undefined;
              }, SIDEBAR_SWIPE_IDLE_RELEASE_MS);
            }
          }}
          className="flex min-h-0 flex-col border-r border-slate-800 bg-app-sidebar"
        >
          <div className="border-b border-slate-800 px-5 py-4">
            <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">
              project-space
            </p>
            {desktop.activeGroup ? (
              <button
                type="button"
                onClick={desktop.navigateToRoot}
                className="mt-3 text-sm text-slate-400 transition hover:text-slate-100"
              >
                ← {desktop.activeGroup.name}
              </button>
            ) : desktop.discoveryRoot ? (
              <p className="mt-3 text-xs text-slate-500">{desktop.discoveryRoot}</p>
            ) : null}
          </div>

          <SidebarViewTabs value={desktop.sidebarView} onChange={desktop.setSidebarView} />

          <div className="relative flex min-h-0 flex-1 overflow-hidden">
            <div ref={currentPanelRef} className="absolute inset-y-0 left-0 w-full">
              <SidebarContent
                onSelectWorkspace={desktop.selectWorkspace}
                project={desktop.project}
                selectedExplorerTarget={desktop.selectedExplorerTarget}
                sidebarView={desktop.sidebarView}
                worktrees={desktop.worktrees}
                onSelectWorktree={desktop.selectWorktree}
              />
            </div>

            {previewProject ? (
              <div ref={previewPanelRef} className="absolute inset-y-0 w-full">
                <SidebarContent
                  onSelectWorkspace={() => undefined}
                  project={previewProject}
                  selectedExplorerTarget={{ kind: 'workspace' }}
                  sidebarView={desktop.sidebarView}
                  worktrees={previewWorktrees}
                  onSelectWorktree={() => undefined}
                />
              </div>
            ) : null}
          </div>

          {desktop.navigationItems.length > 0 ? (
            <SpacesDock
              items={desktop.navigationItems.map((item) => ({
                id: item.id,
                kind: item.kind,
                label: item.label
              }))}
              activeItemId={desktop.activeNavigationItemId}
              canNavigateUp={desktop.canNavigateUp}
              onNavigateUp={desktop.navigateToRoot}
              onSelect={desktop.selectNavigationItem}
              onCreate={desktop.createProject}
            />
          ) : null}
        </aside>

        <main className="flex min-h-0 flex-col bg-app-panel">
          <div className="flex items-center justify-between border-b border-slate-800 px-8 py-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-slate-100">
                {desktop.project?.name ?? 'No project selected'}
              </p>
              {desktop.project ? (
                <p className="mt-1 text-xs uppercase tracking-[0.18em] text-slate-500">
                  {desktop.selectedTargetName}
                </p>
              ) : null}
            </div>

            <OpenTargetDropdown
              apps={desktop.launcherApps}
              disabled={!desktop.project || !desktop.selectedTargetPath}
              onOpen={desktop.openSelectedTargetInApp}
              onSelectApp={desktop.selectLauncherApp}
              selectedApp={desktop.selectedLauncherApp}
              selectedAppLabel={desktop.selectedLauncherAppLabel}
            />
          </div>

          <div className="flex min-h-0 flex-1 items-center justify-center px-8">
            <div className="w-full max-w-2xl">
              {desktop.project ? (
                <>
                  <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">
                    {desktop.selectedExplorerTarget.kind === 'worktree'
                      ? 'Worktree Path'
                      : 'Workspace Path'}
                  </p>
                  <p className="mt-3 font-mono text-xl font-medium tracking-tight text-slate-50">
                    {desktop.selectedTargetPath}
                  </p>
                  {desktop.launcherError ? (
                    <p className="mt-4 text-sm text-amber-300">{desktop.launcherError}</p>
                  ) : null}
                </>
              ) : (
                <div className="space-y-4">
                  <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">
                    No Projects
                  </p>
                  <p className="text-2xl font-semibold tracking-tight text-slate-50">
                    Add projects under {desktop.discoveryRoot || '~/projects'} to discover them.
                  </p>
                  <Button type="button" variant="outline" onClick={desktop.createProject}>
                    Select project
                  </Button>
                </div>
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
