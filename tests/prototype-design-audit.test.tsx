import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  prototypePresentationFromSearch,
  prototypeSelectionFromSearch,
  prototypeSurfaceHref,
  prototypeViewportPresets,
  prototypeWorkspaceSelectionFromSearch,
} from "../src/shared/prototype-canvas";
import { prototypeDeviceOverlayLayout } from "../src/shared/prototype-device-overlay";
import {
  deviceFrameMetrics,
  DeviceFrame,
  prototypeDeviceSafeAreaInsets,
} from "../apps/prototype/src/device-frame";
import { prototypeDesignResponsiveColumns } from "../apps/prototype/src/prototype-design-columns";
import { fitScale } from "../apps/prototype/src/scaled-device-canvas";
import {
  isPrototypeDesignToggleShortcut,
  PrototypeDesignActions,
  PrototypeDesignSettings,
  prototypeDesignShortcuts,
  PrototypeDesignStatus,
  tailwindSpacingPresets,
} from "../apps/prototype/src/prototype-design-settings";
import {
  PrototypeDesignFocusMask,
  PrototypeDesignGridBackdrop,
  PrototypeDesignGridViolationOverlay,
} from "../apps/prototype/src/prototype-design-overlays";
import {
  prototypeDesignAddFibonacciStep,
  prototypeDesignDefaultFibonacciSteps,
  prototypeDesignFinerFibonacciSteps,
  prototypeDesignGridAnalysis,
  prototypeDesignGridLevels,
  prototypeDesignGuideViolations,
  prototypeDesignPrimaryGridLevel,
  prototypeDesignResponsiveFibonacciSteps,
  prototypeDesignSnapPoint,
  prototypeDesignShowHighestFibonacciSteps,
  prototypeDesignToggleFibonacciStep,
} from "../apps/prototype/src/prototype-design-grid-analysis";
import { prototypeDesignMeasurementsEqual } from "../apps/prototype/src/use-prototype-design-measured-state";
import {
  formatPrototypeDesignMeasurement,
  prototypeDesignApprovedBounds,
  prototypeDesignAlignmentRegions,
  prototypeDesignBoundaryCollisionRegions,
  prototypeDesignCollisionRegions,
  prototypeDesignUnapprovedAnchors,
} from "../apps/prototype/src/prototype-design-tool";
import { prototypeDesignPriorityAnalysis } from "../apps/prototype/src/prototype-design-priority";
import {
  prototypeDesignAutoAudit,
  prototypeDesignAuditGridLevels,
  prototypeDesignResponsiveAuditGridLevels,
} from "../apps/prototype/src/prototype-design-auto-audit";

describe("prototype design audit", () => {
  test("marks layers and grid cells when their edges miss the grid", () => {
    const aligned = {
      box: {
        bottom: 40,
        height: 24,
        left: 8,
        right: 32,
        top: 16,
        width: 24,
      },
      label: "div.aligned",
    };
    const offGrid = {
      box: {
        bottom: 40,
        height: 24,
        left: 10,
        right: 31,
        top: 16,
        width: 21,
      },
      label: "form.off-grid",
    };
    const analysis = prototypeDesignGridAnalysis([aligned, offGrid], [8]);

    expect(analysis.layers).toEqual([
      expect.objectContaining({
        edges: ["right", "left"],
        label: "form.off-grid",
      }),
    ]);
    expect(analysis.cells).toHaveLength(2);
    expect(analysis.cells).toContainEqual(
      expect.objectContaining({
        height: 24,
        left: 8,
        orientation: "vertical",
        size: 8,
        top: 16,
      }),
    );
    expect(analysis.cells).toContainEqual(
      expect.objectContaining({
        height: 24,
        left: 24,
        orientation: "vertical",
        size: 8,
        top: 16,
      }),
    );
  });

  test("ignores subpixel drift introduced by a scaled device preview", () => {
    const analysis = prototypeDesignGridAnalysis(
      [
        {
          box: {
            bottom: 204.5,
            height: 40,
            left: 16,
            right: 288,
            top: 164.5,
            width: 272,
          },
          label: "button.scaled-preview",
        },
      ],
      [2],
    );

    expect(analysis).toEqual({ cells: [], layers: [] });
  });

  test("snaps mouse points and flags layers crossed by pinned guides", () => {
    expect(prototypeDesignSnapPoint({ x: 13, y: 19 }, 8)).toEqual({
      x: 16,
      y: 16,
    });
    expect(
      prototypeDesignSnapPoint({ x: 389, y: 843 }, 8, {
        height: 844,
        width: 390,
      }),
    ).toEqual({ x: 390, y: 840 });

    const layer = {
      box: {
        bottom: 40,
        height: 24,
        left: 8,
        right: 32,
        top: 16,
        width: 24,
      },
      label: "button.row",
    };
    expect(
      prototypeDesignGuideViolations(
        [
          { coordinate: 16, key: "vertical-16", orientation: "vertical" },
          { coordinate: 16, key: "horizontal-16", orientation: "horizontal" },
        ],
        [layer],
      ),
    ).toEqual([
      expect.objectContaining({
        guides: ["vertical-16"],
        label: "button.row",
      }),
    ]);
  });

  test("documents every design-tool interaction in ruler settings", () => {
    expect(prototypeDesignShortcuts).toContainEqual({
      action: "Pin guides at cursor",
      keys: ["P"],
    });
    expect(prototypeDesignShortcuts).toContainEqual({
      action: "Toggle design grid",
      keys: ["⌥", "G"],
    });
    expect(prototypeDesignShortcuts).toContainEqual({
      action: "Enter selected layer with a finer grid",
      keys: ["L"],
    });
    expect(prototypeDesignShortcuts).toContainEqual({
      action: "Remove grid from selected layer",
      keys: ["⇧", "L"],
    });
    expect(prototypeDesignShortcuts).toHaveLength(10);
  });

  test("recognizes the physical Option-G shortcut once per key press", () => {
    expect(
      isPrototypeDesignToggleShortcut({
        altKey: true,
        code: "KeyG",
        repeat: false,
      }),
    ).toBe(true);
    expect(
      isPrototypeDesignToggleShortcut({
        altKey: true,
        code: "KeyG",
        repeat: true,
      }),
    ).toBe(false);
    expect(
      isPrototypeDesignToggleShortcut({
        altKey: false,
        code: "KeyG",
        repeat: false,
      }),
    ).toBe(false);
  });

  test("explains the active inspect mode before and after selection", () => {
    expect(
      renderToStaticMarkup(
        <PrototypeDesignStatus
          approvedAncestors={0}
          canEnterLayer={false}
          currentScopeApproved={false}
          gridViolationEdges={0}
          gridViolations={0}
          guideViolations={0}
          nextFix={null}
          remainingFixes={0}
          scope="selection"
          selected={false}
        />,
      ),
    ).toContain("Select an element");
    const violations = renderToStaticMarkup(
      <PrototypeDesignStatus
        approvedAncestors={0}
        canEnterLayer={false}
        currentScopeApproved={false}
        gridViolationEdges={7}
        gridViolations={4}
        guideViolations={1}
        nextFix="main: right edge is 4px off the 24px grid"
        remainingFixes={4}
        scope="global"
        selected
      />,
    );
    expect(violations).toContain("Column audit · layer 1 · 1 of 4");
    expect(violations).toContain("main: right edge is 4px off the 24px grid");
    expect(violations).toContain('data-state="violations"');

    const hidden = renderToStaticMarkup(
      <PrototypeDesignStatus
        approvedAncestors={0}
        canEnterLayer={false}
        currentScopeApproved={false}
        gridViolationEdges={7}
        gridViolations={4}
        gridViolationsVisible={false}
        guideViolations={0}
        nextFix={null}
        remainingFixes={0}
        scope="selection"
        selected
      />,
    );
    expect(hidden).toContain("Grid violations hidden");
    expect(hidden).toContain('data-state="clean"');
  });

  test("offers visible controls for the design-tool keyboard actions", () => {
    const actions = renderToStaticMarkup(<PrototypeDesignActions />);

    expect(actions).toContain("Design tool actions");
    expect(actions).toContain("Pin guides (P)");
    expect(actions).toContain("Enter selected layer with a finer grid (L)");
    expect(actions).toContain("Remove grid from selected layer (⇧ L)");
    expect(actions).toContain("Approve current layer (A)");
    expect(actions).toContain("Select parent layer (↑)");
    expect(actions).toContain("Reset inspection (Esc)");
  });

  test("prioritizes one structural grid fix instead of rendering every violation", () => {
    const priority = prototypeDesignPriorityAnalysis(
      [
        {
          box: {
            bottom: 101,
            height: 101,
            left: 0,
            right: 201,
            top: 0,
            width: 201,
          },
          edges: ["left", "right", "top", "bottom"],
          label: "main",
        },
        {
          box: {
            bottom: 23,
            height: 23,
            left: 3,
            right: 27,
            top: 0,
            width: 24,
          },
          edges: ["left", "right", "top", "bottom"],
          label: "button",
        },
      ],
      8,
    );

    expect(priority.remainingLayers).toBe(2);
    expect(priority.analysis.layers).toHaveLength(1);
    expect(priority.analysis.layers[0]?.label).toBe("main");
    expect(priority.nextFix).toContain("main:");
  });

  test("automatically stops at the first outer violation and marks clean siblings", () => {
    const measured = (label: string, left: number, top: number, right: number, bottom: number) => ({
      box: {
        bottom,
        height: bottom - top,
        left,
        right,
        top,
        width: right - left,
      },
      edges: { bottom: 1, left: 1, right: 1, top: 1 },
      label,
    });
    const right = measured("main", 40, 0, 100, 100);
    const left = measured("aside", 0, 0, 43, 100);
    const audit = prototypeDesignAutoAudit(
      {
        children: [
          { children: [], element: left },
          { children: [], element: right },
        ],
        element: measured("root", 0, 0, 100, 100),
      },
      [10, 5],
    );

    expect(audit.failure?.label).toBe("aside");
    expect(audit.approved.map((element) => element.label)).toContain("main");
    expect(audit.depth).toBe(0);
    expect(audit.gridSize).toBe(10);
    expect(audit.message).toContain("right edge is 3px off");
  });

  test("accepts a grid-sized container anchored to an off-grid parent edge", () => {
    const analysis = prototypeDesignGridAnalysis(
      [
        {
          box: {
            bottom: 390,
            height: 176,
            left: 288,
            right: 820,
            top: 214,
            width: 532,
          },
          label: "composer",
        },
      ],
      [16],
      0.75,
      {
        bottom: 390,
        height: 390,
        left: 288,
        right: 820,
        top: 0,
        width: 532,
      },
    );

    expect(analysis.layers).toHaveLength(0);

    expect(
      prototypeDesignGridAnalysis(
        [
          {
            box: {
              bottom: 390,
              height: 390,
              left: 287.995,
              right: 820,
              top: 0,
              width: 532.005,
            },
            label: "main",
          },
        ],
        [24],
        0.75,
        {
          bottom: 390,
          height: 390,
          left: 0,
          right: 820,
          top: 0,
          width: 820,
        },
      ).layers,
    ).toHaveLength(0);
  });

  test("ignores a flex-growing element along its parent growth axis", () => {
    const analysis = prototypeDesignGridAnalysis(
      [
        {
          box: {
            bottom: 214,
            height: 214,
            left: 288,
            right: 820,
            top: 0,
            width: 532,
          },
          gridExemptEdges: ["top", "bottom"],
          label: "flexible-main-content",
        },
      ],
      [16],
      0.75,
      {
        bottom: 390,
        height: 390,
        left: 288,
        right: 820,
        top: 0,
        width: 532,
      },
    );

    expect(analysis.layers).toHaveLength(0);
  });

  test("checks columns before vertical rhythm in the automatic audit", () => {
    const analysis = prototypeDesignGridAnalysis(
      [
        {
          box: {
            bottom: 213,
            height: 197,
            left: 288,
            right: 816,
            top: 16,
            width: 528,
          },
          label: "column-aligned-row-offset",
        },
      ],
      [16],
      0.75,
      {
        bottom: 390,
        height: 390,
        left: 288,
        right: 816,
        top: 0,
        width: 528,
      },
      "columns",
    );

    expect(analysis.layers).toHaveLength(0);
  });

  test("measures right-side gutters from the parent right edge", () => {
    const analysis = prototypeDesignGridAnalysis(
      [
        {
          box: {
            bottom: 768,
            height: 36,
            left: 24,
            right: 366,
            top: 732,
            width: 342,
          },
          label: "composer-actions",
        },
      ],
      [4],
      0.75,
      {
        bottom: 776,
        height: 116,
        left: 16,
        right: 374,
        top: 660,
        width: 358,
      },
      "columns",
    );

    expect(analysis.layers).toHaveLength(0);
  });

  test("keeps identical live measurements stable", () => {
    expect(
      prototypeDesignMeasurementsEqual(
        { box: { left: 0, width: 288 }, label: "sidebar" },
        { box: { left: 0, width: 288 }, label: "sidebar" },
      ),
    ).toBe(true);
    expect(
      prototypeDesignMeasurementsEqual(
        { box: { left: 0, width: 288 }, label: "sidebar" },
        { box: { left: 0, width: 304 }, label: "sidebar" },
      ),
    ).toBe(false);
  });

  test("moves inward only after the complete outer layer passes", () => {
    const measured = (label: string, left: number, top: number, right: number, bottom: number) => ({
      box: {
        bottom,
        height: bottom - top,
        left,
        right,
        top,
        width: right - left,
      },
      edges: { bottom: 1, left: 1, right: 1, top: 1 },
      label,
    });
    const audit = prototypeDesignAutoAudit(
      {
        children: [
          {
            children: [
              {
                children: [],
                element: measured("button", 13, 10, 30, 30),
              },
            ],
            element: measured("panel", 0, 0, 100, 100),
          },
        ],
        element: measured("root", 0, 0, 100, 100),
      },
      [10, 5],
    );

    expect(audit.failure?.label).toBe("button");
    expect(audit.depth).toBe(1);
    expect(audit.gridSize).toBe(5);
    expect(audit.trail.map((element) => element.label)).toEqual(["root"]);
  });

  test("reports a shared off-grid divider once and keeps the larger sibling passed", () => {
    const measured = (label: string, left: number, right: number) => ({
      box: {
        bottom: 100,
        height: 100,
        left,
        right,
        top: 0,
        width: right - left,
      },
      edges: { bottom: 1, left: 1, right: 1, top: 1 },
      label,
    });
    const audit = prototypeDesignAutoAudit(
      {
        children: [
          { children: [], element: measured("aside", 0, 43) },
          { children: [], element: measured("main", 43, 100) },
        ],
        element: measured("root", 0, 100),
      },
      [10],
    );

    expect(audit.failure?.label).toBe("aside");
    expect(audit.violationsAtStop).toBe(1);
    expect(audit.approved.map((element) => element.label)).toContain("main");
  });

  test("derives progressively finer automatic audit grids", () => {
    expect(
      prototypeDesignAuditGridLevels(
        8,
        "fibonacci",
        prototypeDesignResponsiveFibonacciSteps(
          prototypeDesignDefaultFibonacciSteps(),
          8,
          "phone",
        ),
        4,
      ),
    ).toEqual([24, 16, 8, 4]);
    expect(prototypeDesignResponsiveAuditGridLevels("phone", 4)).toEqual([
      4,
      4,
      4,
      4,
    ]);
    expect(prototypeDesignResponsiveAuditGridLevels("tablet", 4)).toEqual([
      8,
      4,
      4,
      4,
    ]);
    expect(prototypeDesignResponsiveAuditGridLevels("desktop", 4)).toEqual([
      8,
      4,
      4,
      4,
    ]);
  });

});
