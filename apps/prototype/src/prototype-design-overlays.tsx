import type { CSSProperties } from "react";

import type {
  PrototypeDesignGridAnalysis,
  PrototypeDesignFibonacciStep,
  PrototypeDesignGridMode,
  PrototypeDesignGuide,
  PrototypeDesignGuideViolation,
} from "./prototype-design-grid-analysis";
import {
  prototypeDesignGridLevelEntries,
  prototypeDesignGridLevels,
} from "./prototype-design-grid-analysis";
import type {
  LocalBox,
  PrototypeDesignPixelMeasurement,
} from "./prototype-design-analysis";
import {
  prototypeDesignGridLineToken,
  prototypeDesignGridViolationTokens,
} from "./prototype-design-grid-palette";
import type { PrototypeDesignColumnGrid } from "./prototype-design-columns";

export function PrototypeDesignGridBackdrop({
  box,
  columns,
  contrast,
  fibonacciSteps,
  gridMode,
  gridSize,
  hint,
}: {
  box?: LocalBox;
  columns?: PrototypeDesignColumnGrid;
  contrast: number;
  fibonacciSteps?: PrototypeDesignFibonacciStep[];
  gridMode: PrototypeDesignGridMode;
  gridSize: number;
  hint: string;
}) {
  const levelEntries = prototypeDesignGridLevelEntries(
    gridSize,
    gridMode,
    fibonacciSteps,
  )
    .map((entry, _, levels) => ({
      level: entry.level,
      token: prototypeDesignGridLineToken(
        gridMode,
        entry.paletteIndex,
        levels.length,
        contrast,
      ),
    }))
    .reverse();
  const backgroundImage = levelEntries
    .map(
      ({ token }) =>
        `radial-gradient(circle at 1px 1px, ${token} 1px, transparent 1.5px)`,
    )
    .join(",");
  const backgroundSize = levelEntries
    .map(({ level }) => `${level}px ${level}px`)
    .join(",");

  return (
    <>
      {columns ? (
        <div
          className="prototype-design-tool__columns"
          data-column-count={columns.count}
          style={{
            "--prototype-design-column-count": columns.count,
            "--prototype-design-column-gutter": `${columns.gutter}px`,
            "--prototype-design-column-margin": `${columns.margin}px`,
            ...(box
              ? {
                  bottom: "auto",
                  height: box.height,
                  left: box.left,
                  right: "auto",
                  top: box.top,
                  width: box.width,
                }
              : {}),
          } as CSSProperties}
        >
          {Array.from({ length: columns.count }, (_, index) => (
            <span className="prototype-design-tool__column" key={index} />
          ))}
        </div>
      ) : (
        <div
          className="prototype-design-tool__grid"
          data-grid-mode={gridMode}
          data-grid-scope={box ? "layer" : "canvas"}
          style={{
            backgroundImage,
            backgroundSize,
            ...(box
              ? {
                  bottom: "auto",
                  height: box.height,
                  left: box.left,
                  right: "auto",
                  top: box.top,
                  width: box.width,
                }
              : {}),
          }}
        />
      )}
      <div className="prototype-design-tool__hint">{hint}</div>
    </>
  );
}

export function PrototypeDesignPointerOverlay({
  box,
  cursor,
  formatMeasurement,
  pixelMeasurement,
}: {
  box: LocalBox;
  cursor: { x: number; y: number } | null;
  formatMeasurement(pixels: number): string;
  pixelMeasurement: PrototypeDesignPixelMeasurement | null;
}) {
  return (
    <>
      {cursor ? (
        <>
          <div
            className="prototype-design-tool__pixel-line-x"
            style={{ top: cursor.y }}
          />
          <div
            className="prototype-design-tool__pixel-line-y"
            style={{ left: cursor.x }}
          />
          <div
            className="prototype-design-tool__pixel-coordinate"
            style={{ left: cursor.x + 5, top: cursor.y + 5 }}
          >
            x {formatMeasurement(cursor.x - box.left)} · y{" "}
            {formatMeasurement(cursor.y - box.top)}
          </div>
        </>
      ) : null}

      {pixelMeasurement ? (
        <>
          <div
            className="prototype-design-tool__pixel-ruler-x"
            style={{
              left: Math.min(
                pixelMeasurement.start.x,
                pixelMeasurement.end.x,
              ),
              top: pixelMeasurement.start.y,
              width: Math.abs(
                pixelMeasurement.end.x - pixelMeasurement.start.x,
              ),
            }}
          >
            <span>
              Δx{" "}
              {formatMeasurement(
                Math.abs(pixelMeasurement.end.x - pixelMeasurement.start.x),
              )}
            </span>
          </div>
          <div
            className="prototype-design-tool__pixel-ruler-y"
            style={{
              height: Math.abs(
                pixelMeasurement.end.y - pixelMeasurement.start.y,
              ),
              left: pixelMeasurement.end.x,
              top: Math.min(
                pixelMeasurement.start.y,
                pixelMeasurement.end.y,
              ),
            }}
          >
            <span>
              Δy{" "}
              {formatMeasurement(
                Math.abs(pixelMeasurement.end.y - pixelMeasurement.start.y),
              )}
            </span>
          </div>
        </>
      ) : null}
    </>
  );
}

export function PrototypeDesignFocusMask({
  active,
  blurred = false,
  dimmed,
}: {
  active: LocalBox;
  blurred?: boolean;
  dimmed: boolean;
}) {
  return (
    <div
      className="prototype-design-tool__focus-mask"
      data-active={dimmed}
      data-blurred={blurred}
      data-testid="prototype-design-tool-focus-mask"
    >
      {dimmed ? (
        <>
          <div
            className="prototype-design-tool__focus-mask-segment"
            data-side="top"
            style={{ height: active.top }}
          />
          <div
            className="prototype-design-tool__focus-mask-segment"
            data-side="right"
            style={{ left: active.right, top: active.top, height: active.height }}
          />
          <div
            className="prototype-design-tool__focus-mask-segment"
            data-side="bottom"
            style={{ top: active.bottom }}
          />
          <div
            className="prototype-design-tool__focus-mask-segment"
            data-side="left"
            style={{ top: active.top, width: active.left, height: active.height }}
          />
        </>
      ) : null}
    </div>
  );
}

export function PrototypeDesignGridViolationOverlay({
  analysis,
  contrast,
  fibonacciSteps,
  forceRed = false,
  gridMode,
  gridSize,
}: {
  analysis: PrototypeDesignGridAnalysis;
  contrast: number;
  fibonacciSteps?: PrototypeDesignFibonacciStep[];
  forceRed?: boolean;
  gridMode: PrototypeDesignGridMode;
  gridSize: number;
}) {
  const levels = prototypeDesignGridLevels(
    gridSize,
    gridMode,
    fibonacciSteps,
  );
  const violationStyle = (size: number) => {
    if (forceRed) {
      return {
        "--prototype-design-grid-violation-fill": "rgb(127 29 29 / 38%)",
        "--prototype-design-grid-violation-line": "rgb(248 113 113 / 100%)",
        "--prototype-design-grid-violation-ring": "rgb(254 202 202 / 72%)",
      } as CSSProperties;
    }
    const levelIndex = Math.max(0, levels.indexOf(size));
    const tokens = prototypeDesignGridViolationTokens(
      gridMode,
      levelIndex,
      levels.length,
      contrast,
    );
    return {
      "--prototype-design-grid-violation-fill": tokens.fill,
      "--prototype-design-grid-violation-line": tokens.line,
      "--prototype-design-grid-violation-ring": tokens.ring,
    } as CSSProperties;
  };

  return (
    <>
      {analysis.cells.map((cell) => (
        <div
          className="prototype-design-tool__grid-cell-violation"
          data-orientation={cell.orientation}
          data-testid="prototype-design-tool-grid-cell-violation"
          key={cell.key}
          style={{
            ...violationStyle(cell.size),
            height: cell.height,
            left: cell.left,
            top: cell.top,
            width: cell.width,
          }}
        />
      ))}
      {analysis.layers.map((layer) => (
        <div
          className="prototype-design-tool__grid-layer-violation"
          data-edges={layer.edges.join(" ")}
          data-label={layer.label}
          data-testid="prototype-design-tool-grid-layer-violation"
          key={layer.key}
          style={{
            ...violationStyle(analysis.cells[0]?.size ?? gridSize),
            height: layer.box.height,
            left: layer.box.left,
            top: layer.box.top,
            width: layer.box.width,
          }}
        />
      ))}
    </>
  );
}

export function PrototypeDesignGuideOverlay({
  formatCoordinate,
  guides,
  violations,
}: {
  formatCoordinate(coordinate: number): string;
  guides: PrototypeDesignGuide[];
  violations: PrototypeDesignGuideViolation[];
}) {
  return (
    <>
      {guides.map((guide) => (
        <div
          className={`prototype-design-tool__guide prototype-design-tool__guide--${guide.orientation}`}
          data-testid="prototype-design-tool-guide"
          key={guide.key}
          style={
            guide.orientation === "vertical"
              ? { left: guide.coordinate }
              : { top: guide.coordinate }
          }
        >
          <span>
            {guide.orientation === "vertical" ? "x" : "y"}{" "}
            {formatCoordinate(guide.coordinate)}
          </span>
        </div>
      ))}
      {violations.map((violation) => (
        <div
          className="prototype-design-tool__guide-violation"
          data-testid="prototype-design-tool-guide-violation"
          key={violation.key}
          style={{
            height: violation.box.height,
            left: violation.box.left,
            top: violation.box.top,
            width: violation.box.width,
          }}
        >
          <span>guide</span>
        </div>
      ))}
    </>
  );
}
