import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PrototypeViewportKind } from "../../../src/shared/prototype-canvas";
import {
  prototypeDesignApprovedBounds,
  prototypeDesignAlignmentRegions,
  prototypeDesignBoundaryCollisionRegions,
  prototypeDesignCollisionRegions,
  prototypeDesignUnapprovedAnchors,
  type LocalBox,
  type MeasuredElement,
  type PrototypeDesignInspection,
  type PrototypeDesignPixelMeasurement,
  type PrototypeDesignUnit,
} from "./prototype-design-analysis";
import {
  prototypeDesignAuditGridLevels,
  prototypeDesignAuditTree,
  prototypeDesignAutoAudit,
  prototypeDesignResponsiveAuditGridLevels,
  type PrototypeDesignAutoAuditResult,
} from "./prototype-design-auto-audit";
import { PrototypeDesignInnerOverlay } from "./prototype-design-inner-overlay";
import {
  PrototypeDesignGridStatus,
  PrototypeDesignReferenceLabel,
} from "./prototype-design-grid-status";
import {
  prototypeDesignDefaultFibonacciSteps,
  prototypeDesignGuideViolations,
  prototypeDesignSnapPoint,
  type PrototypeDesignGridMode,
  type PrototypeDesignFibonacciStep,
  type PrototypeDesignGuide,
} from "./prototype-design-grid-analysis";
import {
  PrototypeDesignFocusMask,
  PrototypeDesignGridViolationOverlay,
  PrototypeDesignGuideOverlay,
  PrototypeDesignPointerOverlay,
} from "./prototype-design-overlays";
import {
  prototypeDesignAuditRoot,
  prototypeDesignDescendantAnchors,
  prototypeDesignElementPath,
  prototypeDesignElementLabel,
  prototypeDesignGridExemptEdges,
  prototypeDesignInnerElement,
  prototypeDesignInspectableElement,
  prototypeDesignInspectableParent,
  prototypeDesignLocalBox,
  prototypeDesignLocalPoint,
  prototypeDesignPointDistance,
  prototypeDesignVisibleEdges,
  type PrototypeDesignPoint,
} from "./prototype-design-dom";
import { prototypeDesignPriorityAnalysis } from "./prototype-design-priority";
import { PrototypeDesignResultOverlays } from "./prototype-design-result-overlays";
import type { PrototypeDesignStatusSnapshot } from "./prototype-design-settings";
import { usePrototypeDesignMeasurement } from "./use-prototype-design-measurement";
import { usePrototypeDesignMeasuredState } from "./use-prototype-design-measured-state";
import { usePrototypeResponsiveLayerGrid } from "./use-prototype-responsive-layer-grid";
import { usePrototypeDesignStatus } from "./use-prototype-design-status";
export * from "./prototype-design-analysis";
export function PrototypeDesignTool({
  auditRequest = 0,
  enabled,
  fibonacciSteps = prototypeDesignDefaultFibonacciSteps(),
  gridContrast = 100,
  gridMode = "fibonacci",
  gridSize = 2,
  onSelectionChange,
  showGridViolations = true,
  unit = "grid",
  viewportKind = "desktop",
}: {
  auditRequest?: number;
  enabled: boolean;
  fibonacciSteps?: PrototypeDesignFibonacciStep[];
  gridContrast?: number;
  gridMode?: PrototypeDesignGridMode;
  gridSize?: number;
  onSelectionChange?(snapshot: PrototypeDesignStatusSnapshot): void;
  showGridViolations?: boolean;
  unit?: PrototypeDesignUnit;
  viewportKind?: PrototypeViewportKind;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const dragStartRef = useRef<PrototypeDesignPoint | null>(null);
  const cursorRef = useRef<PrototypeDesignPoint | null>(null);
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [innerTarget, setInnerTarget] = useState<HTMLElement | null>(null);
  const [cursor, setCursor] = useState<PrototypeDesignPoint | null>(null);
  const [pixelMeasurement, setPixelMeasurement] =
    useState<PrototypeDesignPixelMeasurement | null>(null);
  const [locked, setLocked] = useState(false);
  const [inspection, setInspection] =
    usePrototypeDesignMeasuredState<PrototypeDesignInspection>();
  const [automaticAudit, setAutomaticAudit] =
    usePrototypeDesignMeasuredState<PrototypeDesignAutoAuditResult>();
  const [approvedTargets, setApprovedTargets] = useState<HTMLElement[]>([]);
  const [approvedScopePaths, setApprovedScopePaths] = useState<string[]>([]);
  const [guides, setGuides] = useState<PrototypeDesignGuide[]>([]);
  const [scope, setScope] =
    useState<PrototypeDesignStatusSnapshot["scope"]>("selection");
  const {
    activeFibonacciSteps,
    activeGridContrast,
    activeGridLevel,
    activeGridMode,
    activeGridSize,
    activeLayerGrid,
    layerGrids,
  } = usePrototypeResponsiveLayerGrid({
    contrast: gridContrast,
    fibonacciSteps,
    mode: gridMode,
    root: overlayRef.current?.parentElement ?? null,
    size: gridSize,
    target,
    viewport: viewportKind,
  });
  const activeFibonacciSignature = activeFibonacciSteps
    .map((step) => `${step.multiplier}:${step.visible ? 1 : 0}`)
    .join(",");
  const auditGridLevels = useMemo(
    () => prototypeDesignResponsiveAuditGridLevels(viewportKind),
    [viewportKind],
  );
  const screen = overlayRef.current?.parentElement ?? null;
  const rawScopePath = target && screen
    ? prototypeDesignElementPath(target, screen)
    : null;
  const currentScopePath = rawScopePath === null
    ? null
    : rawScopePath
      ? `$root > ${rawScopePath}`
      : "$root";
  const currentScopeApproved = Boolean(
    currentScopePath && approvedScopePaths.includes(currentScopePath),
  );
  const approvedAncestors = currentScopePath
    ? approvedScopePaths.filter((path) =>
        currentScopePath.startsWith(`${path} > `),
      ).length
    : 0;
  useEffect(() => {
    if (!enabled || (auditRequest === 0 && locked)) return;
    const overlay = overlayRef.current;
    const screen = overlay?.parentElement;
    const appRoot = screen && overlay
      ? prototypeDesignAuditRoot(screen, overlay)
      : null;
    if (!appRoot) return;
    setTarget(appRoot);
    setInnerTarget(null);
    setCursor(null);
    setPixelMeasurement(null);
    setApprovedTargets([]);
    setApprovedScopePaths([]);
    setGuides([]);
    setLocked(true);
    setScope("global");
  }, [auditRequest, enabled]);
  useEffect(() => {
    cursorRef.current = cursor;
  }, [cursor]);
  useEffect(() => {
    setGuides((current) => {
      const snapped = current.map((guide) => {
        const point = prototypeDesignSnapPoint(
          { x: guide.coordinate, y: guide.coordinate },
          activeGridLevel,
        );
        const coordinate = guide.orientation === "vertical" ? point.x : point.y;
        return {
          ...guide,
          coordinate,
          key: `${guide.orientation}-${coordinate}`,
        };
      });
      return [...new Map(snapped.map((guide) => [guide.key, guide])).values()];
    });
  }, [activeGridLevel]);
  const measure = useCallback(() => {
    const overlay = overlayRef.current;
    const screen = overlay?.parentElement;
    if (!overlay || !screen || !target || !screen.contains(target)) {
      setInspection(null);
      setAutomaticAudit(null);
      return;
    }
    const screenRect = screen.getBoundingClientRect();
    const scaleX = screenRect.width / screen.clientWidth;
    const scaleY = screenRect.height / screen.clientHeight;
    const toMeasuredElement = (element: HTMLElement): MeasuredElement => ({
      box: prototypeDesignLocalBox(element, screenRect, scaleX, scaleY),
      edges: prototypeDesignVisibleEdges(element),
      gridExemptEdges: prototypeDesignGridExemptEdges(element),
      label: prototypeDesignElementLabel(element),
    });
    const targetBox = prototypeDesignLocalBox(
      target,
      screenRect,
      scaleX,
      scaleY,
    );
    const approvedElements = approvedTargets.filter(
      (element) => screen.contains(element) && target.contains(element),
    );
    const approved = approvedElements.map(toMeasuredElement);
    const active = prototypeDesignApprovedBounds(
      targetBox,
      approved.map((element) => element.box),
    );
    const anchors = locked
      ? prototypeDesignUnapprovedAnchors(
          prototypeDesignDescendantAnchors(target).map(toMeasuredElement),
          active,
          approved.map((element) => element.box),
        )
      : [];
    const innerIsApproved =
      innerTarget &&
      approvedElements.some(
        (element) => element === innerTarget || element.contains(innerTarget),
      );
    setInspection({
      active,
      anchors,
      approved,
      inner:
        locked &&
        innerTarget &&
        !innerIsApproved &&
        target.contains(innerTarget)
          ? toMeasuredElement(innerTarget)
          : null,
      label: prototypeDesignElementLabel(target),
      target: targetBox,
    });
    setAutomaticAudit(
      scope === "global"
        ? prototypeDesignAutoAudit(
            prototypeDesignAuditTree(target, toMeasuredElement),
            auditGridLevels,
          )
        : null,
    );
  }, [
    auditGridLevels,
    approvedTargets,
    innerTarget,
    locked,
    scope,
    target,
  ]);

  useLayoutEffect(() => {
    measure();
    const overlay = overlayRef.current;
    const screen = overlay?.parentElement;
    if (!screen) return;
    const observer = new ResizeObserver(measure);
    observer.observe(screen);
    if (target) observer.observe(target);
    screen.addEventListener("scroll", measure, { passive: true });
    return () => {
      observer.disconnect();
      screen.removeEventListener("scroll", measure);
    };
  }, [measure]);
  useEffect(() => {
    const overlay = overlayRef.current;
    const screen = overlay?.parentElement;
    if (!enabled || !screen) {
      setTarget(null);
      setAutomaticAudit(null);
      setInnerTarget(null);
      setCursor(null);
      setPixelMeasurement(null);
      setLocked(false);
      setApprovedTargets((current) => current.length ? [] : current);
      setApprovedScopePaths((current) => current.length ? [] : current);
      setGuides((current) => current.length ? [] : current);
      setScope("selection");
      return;
    }

    const pointFromEvent = (event: PointerEvent) =>
      prototypeDesignSnapPoint(
        prototypeDesignLocalPoint(event, screen),
        activeGridLevel,
        { height: screen.clientHeight, width: screen.clientWidth },
      );
    const pinPoint = (point: PrototypeDesignPoint) => {
      setGuides((current) => {
        const additions: PrototypeDesignGuide[] = [
          {
            coordinate: point.x,
            key: `vertical-${point.x}`,
            orientation: "vertical",
          },
          {
            coordinate: point.y,
            key: `horizontal-${point.y}`,
            orientation: "horizontal",
          },
        ];
        return [
          ...new Map(
            [...current, ...additions].map((guide) => [guide.key, guide]),
          ).values(),
        ];
      });
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (locked && target) {
        const point = pointFromEvent(event);
        setCursor(point);
        if (dragStartRef.current) {
          setPixelMeasurement({ end: point, start: dragStartRef.current });
          return;
        }
        setInnerTarget(
          prototypeDesignInnerElement(event.target, target, screen),
        );
        return;
      }
      setTarget(prototypeDesignInspectableElement(event.target, screen));
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (locked && target) {
        const point = pointFromEvent(event);
        if (event.altKey) {
          pinPoint(point);
          setCursor(point);
          setPixelMeasurement(null);
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        dragStartRef.current = point;
        setCursor(point);
        setPixelMeasurement({ end: point, start: point });
        const nextInner = prototypeDesignInnerElement(
          event.target,
          target,
          screen,
        );
        setInnerTarget(nextInner);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const next = prototypeDesignInspectableElement(event.target, screen);
      if (!next) return;
      event.preventDefault();
      event.stopPropagation();
      setTarget(next);
      setInnerTarget(null);
      setCursor(null);
      setPixelMeasurement(null);
      setApprovedTargets([]);
      setGuides([]);
      setLocked(true);
      setScope("selection");
    };
    const handlePointerUp = (event: PointerEvent) => {
      const start = dragStartRef.current;
      if (!start) return;
      const end = pointFromEvent(event);
      dragStartRef.current = null;
      if (prototypeDesignPointDistance(start, end) < 2) {
        setPixelMeasurement(null);
      } else {
        setPixelMeasurement({ end, start });
      }
      event.preventDefault();
      event.stopPropagation();
    };
    const handleClick = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      const eventTarget = event.target;
      const isTyping =
        eventTarget instanceof HTMLInputElement ||
        eventTarget instanceof HTMLTextAreaElement ||
        (eventTarget instanceof HTMLElement && eventTarget.isContentEditable);
      if (
        !isTyping &&
        event.key.toLowerCase() === "l" &&
        locked &&
        scope !== "global"
      ) {
        const layerTarget = innerTarget ?? target;
        if (!layerTarget) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.shiftKey) {
          layerGrids.remove(layerTarget, screen);
        } else if (currentScopeApproved) {
          layerGrids.apply(layerTarget, screen);
          setTarget(layerTarget);
          setInnerTarget(null);
          setScope("selection");
        }
        return;
      }
      if (
        !isTyping &&
        event.key.toLowerCase() === "a" &&
        locked &&
        scope !== "global"
      ) {
        event.preventDefault();
        event.stopPropagation();
        if (event.shiftKey) {
          setApprovedScopePaths([]);
        } else if (currentScopePath) {
          setApprovedScopePaths((current) =>
            current.includes(currentScopePath)
              ? current
              : [...current, currentScopePath],
          );
        }
        return;
      }
      if (!isTyping && event.key.toLowerCase() === "p" && locked) {
        event.preventDefault();
        event.stopPropagation();
        if (event.shiftKey) setGuides([]);
        else if (cursorRef.current) pinPoint(cursorRef.current);
        return;
      }
      if (
        event.shiftKey &&
        event.key === "ArrowUp" &&
        locked &&
        target &&
        innerTarget
      ) {
        const parent = innerTarget.parentElement;
        if (!parent || parent === target || !target.contains(parent)) return;
        event.preventDefault();
        event.stopPropagation();
        setInnerTarget(parent);
        return;
      }
      if (event.key === "ArrowUp" && locked && target && scope !== "global") {
        const parent = prototypeDesignInspectableParent(target, screen);
        if (!parent) return;
        event.preventDefault();
        event.stopPropagation();
        setTarget(parent);
        setInnerTarget(null);
        setCursor(null);
        setPixelMeasurement(null);
        setApprovedTargets([]);
        setGuides([]);
        setScope("selection");
        return;
      }
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setLocked(false);
      setTarget(null);
      setInnerTarget(null);
      setCursor(null);
      setPixelMeasurement(null);
      setApprovedTargets([]);
      setGuides([]);
      setScope("selection");
      dragStartRef.current = null;
    };

    screen.addEventListener("pointermove", handlePointerMove, true);
    screen.addEventListener("pointerdown", handlePointerDown, true);
    screen.addEventListener("pointerup", handlePointerUp, true);
    screen.addEventListener("click", handleClick, true);
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      screen.removeEventListener("pointermove", handlePointerMove, true);
      screen.removeEventListener("pointerdown", handlePointerDown, true);
      screen.removeEventListener("pointerup", handlePointerUp, true);
      screen.removeEventListener("click", handleClick, true);
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [
    activeGridLevel,
    currentScopeApproved,
    currentScopePath,
    enabled,
    innerTarget,
    layerGrids,
    locked,
    scope,
    target,
  ]);

  const box = inspection?.active;
  const inner = scope === "global" ? null : inspection?.inner;
  const detailedInner = scope === "selection" ? inner : null;
  const boundaryCollisionRegions =
    box && inspection?.approved.length
      ? prototypeDesignBoundaryCollisionRegions(box, inspection.anchors)
      : [];
  const collisionRegions = [
    ...boundaryCollisionRegions,
    ...(detailedInner
      ? prototypeDesignCollisionRegions(
          detailedInner.box,
          inspection?.anchors ?? [],
        )
      : []),
  ];
  const alignmentRegions = detailedInner
    ? prototypeDesignAlignmentRegions(
        detailedInner.box,
        inspection?.anchors ?? [],
      )
    : [];
  const alignedBoxCount = alignmentRegions.filter(
    (region) => region.kind === "box",
  ).length;
  const priority = prototypeDesignPriorityAnalysis(
    inspection?.anchors ?? [],
    activeGridLevel,
  );
  const automatic = scope === "global" ? automaticAudit : null;
  const gridAnalysis = automatic?.analysis ?? (
    currentScopeApproved ? { cells: [], layers: [] } : priority.analysis
  );
  const focusBox = automatic?.failure?.box ?? box;
  const passedElements = automatic?.approved ?? inspection?.approved ?? [];
  const displayedGridSize = automatic?.gridSize ?? activeGridSize;
  const displayedGridMode = automatic ? "fibonacci" : activeGridMode;
  const displayedFibonacciSteps = automatic
    ? [{ multiplier: 1, visible: true }]
    : activeFibonacciSteps;
  const displayedViolationLayers = automatic
    ? automatic.violationsAtStop
    : currentScopeApproved
      ? 0
      : priority.remainingLayers;
  const displayedViolationEdges = automatic
    ? automatic.analysis.layers[0]?.edges.length ?? 0
    : currentScopeApproved
      ? 0
      : priority.remainingEdges;
  const guideViolations = inspection
    ? prototypeDesignGuideViolations(guides, inspection.anchors)
    : [];
  usePrototypeDesignStatus(
    onSelectionChange,
    enabled && locked,
    enabled && locked && showGridViolations ? displayedViolationLayers : 0,
    enabled && locked && showGridViolations ? displayedViolationEdges : 0,
    enabled && locked ? guideViolations.length : 0,
    scope,
    automatic?.trail.length ?? approvedAncestors,
    !automatic && currentScopeApproved && Boolean(innerTarget),
    automatic ? !automatic.failure : currentScopeApproved,
    automatic ? automatic.message : currentScopeApproved ? null : priority.nextFix,
    automatic ? automatic.violationsAtStop : currentScopeApproved ? 0 : priority.remainingLayers,
  );
  const measurement = usePrototypeDesignMeasurement(
    automatic?.gridSize ?? activeGridLevel,
    unit,
  );
  return (
    <div
      ref={overlayRef}
      aria-hidden
      className={`prototype-design-tool ${enabled ? "prototype-design-tool--enabled" : ""}`}
      data-grid-base={activeGridSize}
      data-grid-size={activeGridLevel}
      data-grid-contrast={activeGridContrast}
      data-testid="prototype-design-tool"
      data-unit={unit}
    >
      {enabled ? (
        <>
          <PrototypeDesignGridStatus
            affectedLayers={displayedViolationLayers}
            box={automatic?.failure?.box ?? (
              activeLayerGrid ? inspection?.target : undefined
            )}
            canvasWidth={inspection?.target.width ?? 0}
            fibonacciSteps={displayedFibonacciSteps}
            gridContrast={activeGridContrast}
            gridMode={displayedGridMode}
            gridSize={displayedGridSize}
            gridViolations={displayedViolationEdges}
            guideViolations={guideViolations.length}
            inner={Boolean(inner)}
            locked={locked}
            scope={scope}
            showGridViolations={showGridViolations}
          />
          {box ? (
            <>
              <div
                className="prototype-design-tool__container"
                data-approved={Boolean(automatic && !automatic.failure) || currentScopeApproved}
                style={{
                  height: box.height,
                  left: box.left,
                  top: box.top,
                  width: box.width,
                }}
              />
              <PrototypeDesignFocusMask
                active={focusBox ?? box}
                blurred={Boolean(automatic?.failure)}
                dimmed={
                  Boolean(automatic?.failure) ||
                  Boolean(activeLayerGrid) ||
                  passedElements.length > 0
                }
              />
              {showGridViolations ? (
                <PrototypeDesignGridViolationOverlay
                  analysis={gridAnalysis}
                  contrast={activeGridContrast}
                  fibonacciSteps={displayedFibonacciSteps}
                  forceRed={Boolean(automatic)}
                  gridMode={displayedGridMode}
                  gridSize={displayedGridSize}
                />
              ) : null}
              <PrototypeDesignGuideOverlay
                formatCoordinate={measurement}
                guides={guides}
                violations={guideViolations}
              />
              <div
                className="prototype-design-tool__active-line-x"
                style={{ top: box.top }}
              />
              <div
                className="prototype-design-tool__active-line-x"
                style={{ top: box.bottom }}
              />
              <div
                className="prototype-design-tool__active-line-y"
                style={{ left: box.left }}
              />
              <div
                className="prototype-design-tool__active-line-y"
                style={{ left: box.right }}
              />
              <PrototypeDesignResultOverlays
                collisions={collisionRegions}
                formatMeasurement={measurement}
                passed={passedElements}
              />
              <PrototypeDesignPointerOverlay
                box={box}
                cursor={scope === "global" ? null : cursor}
                formatMeasurement={measurement}
                pixelMeasurement={pixelMeasurement}
              />

              {inner ? (
                <PrototypeDesignInnerOverlay
                  alignmentRegions={alignmentRegions}
                  box={box}
                  detailed={scope === "selection"}
                  inner={inner}
                  measurement={measurement}
                />
              ) : null}

              <PrototypeDesignReferenceLabel
                activeLayerSize={automatic?.gridSize ?? activeGridLevel}
                approvedAncestors={automatic?.trail.length ?? approvedAncestors}
                box={automatic?.failure?.box ?? box}
                currentScopeApproved={
                  automatic ? !automatic.failure : currentScopeApproved
                }
                label={automatic?.failure?.label ?? inspection.label}
                measurement={measurement}
                scope={automatic && automatic.depth > 0 ? "selection" : scope}
              />
            </>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
