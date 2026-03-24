import { useEffect, useMemo, useRef, useState } from 'react';
import type { WheelEvent } from 'react';
import type {
  ProjectNavigationItem,
  ProjectSpaceRecord,
  ProjectWorktreeRecord
} from '@/shared/electron-api';

const SIDEBAR_SWIPE_PREVIEW_LIMIT = 148;
const SIDEBAR_SWIPE_SNAP_THRESHOLD = 82;
const SIDEBAR_SWIPE_DIRECTION_THRESHOLD = 12;
const SIDEBAR_SWIPE_IDLE_RELEASE_MS = 220;
const SIDEBAR_SWIPE_STEP_LOCK_RELEASE_MS = 260;
const SIDEBAR_SWIPE_TENSION_SPLIT = 0.58;
const SIDEBAR_SWIPE_TENSION_EXPONENT = 1.7;
const SIDEBAR_SWIPE_RELEASE_EXPONENT = 1.2;
const SIDEBAR_SWIPE_SPLIT_PROGRESS = 0.68;

interface SidebarNavigationSelection {
  nextGroupId: string;
  nextProjectId: string;
}

interface UseSidebarSwipeNavigationOptions {
  activeNavigationItemId: string;
  isSidebarOpen: boolean;
  navigationItems: ProjectNavigationItem[];
  projects: ProjectSpaceRecord[];
  resolveNavigationSelection(itemId: string): SidebarNavigationSelection | null;
  selectNavigationItem(
    itemId: string,
    nextWorktrees?: ProjectWorktreeRecord[],
    nextSelectedWorktreeId?: string
  ): void;
  sidebarWidth: number;
}

export function useSidebarSwipeNavigation({
  activeNavigationItemId,
  isSidebarOpen,
  navigationItems,
  projects,
  resolveNavigationSelection,
  selectNavigationItem,
  sidebarWidth
}: UseSidebarSwipeNavigationOptions) {
  const [previewDirection, setPreviewDirection] = useState<-1 | 0 | 1>(0);
  const [previewItemId, setPreviewItemId] = useState('');
  const [previewWorktrees, setPreviewWorktrees] = useState<ProjectWorktreeRecord[]>([]);
  const currentPanelRef = useRef<HTMLDivElement | null>(null);
  const previewPanelRef = useRef<HTMLDivElement | null>(null);
  const swipeState = useRef({
    animationFrameId: 0 as number | undefined,
    idleTimeoutId: 0 as number | undefined,
    isGestureActive: false,
    isSettling: false,
    lockedDirection: 0 as -1 | 0 | 1,
    offset: 0,
    previewDirection: 0 as -1 | 0 | 1,
    previewItemId: '',
    settleTimeoutId: 0 as number | undefined,
    stepLockTimeoutId: 0 as number | undefined
  });

  const activeNavigationIndex = useMemo(() => {
    const index = navigationItems.findIndex((entry) => entry.id === activeNavigationItemId);

    return index >= 0 ? index : 0;
  }, [activeNavigationItemId, navigationItems]);

  const previewItem = useMemo(() => {
    return navigationItems.find((entry) => entry.id === previewItemId);
  }, [navigationItems, previewItemId]);

  const previewSelection = useMemo(() => {
    return previewItem ? resolveNavigationSelection(previewItem.id) : null;
  }, [previewItem, resolveNavigationSelection]);

  const previewProject = useMemo(() => {
    return previewSelection?.nextProjectId
      ? projects.find((entry) => entry.id === previewSelection.nextProjectId)
      : undefined;
  }, [previewSelection, projects]);

  useEffect(() => {
    const unsubscribe = window.projectSpace.onGestureScrollState((state) => {
      swipeState.current.isGestureActive = state === 'begin';

      if (state === 'end' && !swipeState.current.isSettling && swipeState.current.offset !== 0) {
        settleSwipe();
      }

      if (state === 'end') {
        releaseStepLock();
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

      if (swipeState.current.stepLockTimeoutId) {
        window.clearTimeout(swipeState.current.stepLockTimeoutId);
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
    if (isSidebarOpen) {
      return;
    }

    resetSwipeState();
  }, [isSidebarOpen]);

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

  function releaseStepLock() {
    if (swipeState.current.stepLockTimeoutId) {
      window.clearTimeout(swipeState.current.stepLockTimeoutId);
      swipeState.current.stepLockTimeoutId = undefined;
    }

    swipeState.current.lockedDirection = 0;
  }

  function refreshStepLock(direction: -1 | 0 | 1) {
    if (direction === 0) {
      releaseStepLock();
      return;
    }

    swipeState.current.lockedDirection = direction;

    if (swipeState.current.stepLockTimeoutId) {
      window.clearTimeout(swipeState.current.stepLockTimeoutId);
    }

    swipeState.current.stepLockTimeoutId = window.setTimeout(() => {
      swipeState.current.lockedDirection = 0;
      swipeState.current.stepLockTimeoutId = undefined;
    }, SIDEBAR_SWIPE_STEP_LOCK_RELEASE_MS);
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
        ? swipeState.current.previewDirection * sidebarWidth
        : 0;

    if (shouldSwitch) {
      refreshStepLock(swipeState.current.previewDirection);
    }

    scheduleSwipeTransform();

    swipeState.current.settleTimeoutId = window.setTimeout(() => {
      if (shouldSwitch && targetItemId) {
        selectNavigationItem(targetItemId, previewWorktrees);
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
    if (nextIndex < 0 || nextIndex >= navigationItems.length) {
      swipeState.current.previewItemId = '';
      swipeState.current.previewDirection = 0;
      setPreviewDirection(0);
      setPreviewItemId('');
      setPreviewWorktrees([]);
      return;
    }

    const nextItem = navigationItems[nextIndex];
    swipeState.current.previewDirection = direction;
    swipeState.current.previewItemId = nextItem?.id ?? '';
    setPreviewDirection(direction);
    setPreviewItemId(nextItem?.id ?? '');
  }

  function handleSidebarWheel(event: WheelEvent<HTMLElement>) {
    if (!isSidebarOpen || navigationItems.length < 2) {
      return;
    }

    if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) {
      return;
    }

    event.preventDefault();

    if (swipeState.current.isSettling) {
      return;
    }

    const incomingDirection =
      event.deltaX > SIDEBAR_SWIPE_DIRECTION_THRESHOLD
        ? 1
        : event.deltaX < -SIDEBAR_SWIPE_DIRECTION_THRESHOLD
          ? -1
          : 0;

    if (incomingDirection === 0) {
      return;
    }

    if (swipeState.current.lockedDirection !== 0) {
      if (incomingDirection === swipeState.current.lockedDirection) {
        refreshStepLock(incomingDirection);
        return;
      }

      releaseStepLock();
    }

    if (swipeState.current.idleTimeoutId) {
      window.clearTimeout(swipeState.current.idleTimeoutId);
    }

    const atFirstItem = activeNavigationIndex <= 0;
    const atLastItem = activeNavigationIndex >= navigationItems.length - 1;
    const wantsPrevious = event.deltaX < 0;
    const wantsNext = event.deltaX > 0;
    const pushingPastEdge = (atFirstItem && wantsPrevious) || (atLastItem && wantsNext);
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
  }

  return {
    currentPanelRef,
    handleSidebarWheel,
    previewPanelRef,
    previewProject,
    previewWorktrees
  };
}
