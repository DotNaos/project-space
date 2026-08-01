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

describe("prototype design grid", () => {
  test("offers a slider and every Tailwind spacing preset for grid size", () => {
    const settings = renderToStaticMarkup(
      <PrototypeDesignSettings
        fibonacciSteps={prototypeDesignDefaultFibonacciSteps()}
        gridContrast={160}
        gridMode="fibonacci"
        gridSize={8}
        unit="grid"
        onGridModeChange={() => undefined}
        onGridContrastChange={() => undefined}
        onFibonacciStepAdd={() => undefined}
        onFibonacciStepDepthChange={() => undefined}
        onFibonacciStepToggle={() => undefined}
        onGridSizeChange={() => undefined}
        onUnitChange={() => undefined}
      />,
    );

    expect(tailwindSpacingPresets).toHaveLength(35);
    expect(tailwindSpacingPresets[0]).toEqual({ pixels: 0, token: "0" });
    expect(tailwindSpacingPresets.at(-1)).toEqual({
      pixels: 384,
      token: "96",
    });
    expect(settings).toContain("Design grid settings");
    expect(prototypeDesignGridLevels(2, "fibonacci")).toEqual([16]);
    expect(
      prototypeDesignPrimaryGridLevel(2, "fibonacci"),
    ).toBe(16);
  });

  test("draws each Fibonacci grid level with its own color", () => {
    const allSteps = prototypeDesignDefaultFibonacciSteps().map((step) => ({
      ...step,
      visible: true,
    }));
    const grid = renderToStaticMarkup(
      <PrototypeDesignGridBackdrop
        contrast={200}
        fibonacciSteps={allSteps}
        gridMode="fibonacci"
        gridSize={2}
        hint="Fibonacci grid"
      />,
    );

    expect(grid).toContain("--prototype-design-grid-fibonacci-1");
    expect(grid).toContain("--prototype-design-grid-fibonacci-2");
    expect(grid).toContain("--prototype-design-grid-fibonacci-3");
    expect(grid).toContain("--prototype-design-grid-fibonacci-5");
    expect(grid).toContain("--prototype-design-grid-fibonacci-8");
    expect(grid).toContain("radial-gradient");
    expect(grid).not.toContain("linear-gradient");
    expect(grid).toContain("10%");
  });

  test("clips a layer grid to the selected DOM layer", () => {
    const grid = renderToStaticMarkup(
      <PrototypeDesignGridBackdrop
        box={{ height: 32, left: 12, top: 16, width: 128 }}
        contrast={100}
        gridMode="linear"
        gridSize={8}
        hint="Layer grid"
      />,
    );

    expect(grid).toContain('data-grid-scope="layer"');
    expect(grid).toContain("height:32px");
    expect(grid).toContain("left:12px");
    expect(grid).toContain("width:128px");
  });

  test("can hide and extend Fibonacci grid levels", () => {
    const defaults = prototypeDesignDefaultFibonacciSteps().map((step) => ({
      ...step,
      visible: true,
    }));
    const hidden = prototypeDesignToggleFibonacciStep(defaults, 2);
    const extended = prototypeDesignAddFibonacciStep(hidden);
    const highestOnly = prototypeDesignShowHighestFibonacciSteps(extended, 1);
    const grid = renderToStaticMarkup(
      <PrototypeDesignGridBackdrop
        contrast={160}
        fibonacciSteps={extended}
        gridMode="fibonacci"
        gridSize={2}
        hint="Custom Fibonacci grid"
      />,
    );

    expect(hidden.find((step) => step.multiplier === 2)?.visible).toBe(false);
    expect(extended.at(-1)).toEqual({ multiplier: 13, visible: true });
    expect(highestOnly.filter((step) => step.visible)).toEqual([
      { multiplier: 13, visible: true },
    ]);
    expect(grid).not.toContain("--prototype-design-grid-fibonacci-2-swatch");
    expect(grid).toContain("--prototype-design-grid-fibonacci-13-swatch");
  });

  test("steps into one finer Fibonacci grid at each nested layer", () => {
    const configured = prototypeDesignDefaultFibonacciSteps();
    const firstLayer = prototypeDesignFinerFibonacciSteps(configured);
    const secondLayer = prototypeDesignFinerFibonacciSteps(firstLayer, 5);

    expect(configured.filter((step) => step.visible)).toEqual([
      { multiplier: 8, visible: true },
    ]);
    expect(firstLayer.filter((step) => step.visible)).toEqual([
      { multiplier: 5, visible: true },
    ]);
    expect(secondLayer.filter((step) => step.visible)).toEqual([
      { multiplier: 3, visible: true },
    ]);
  });

  test("caps the root Fibonacci grid for phone-sized previews", () => {
    const configured = prototypeDesignDefaultFibonacciSteps();
    const phone = prototypeDesignResponsiveFibonacciSteps(
      configured,
      8,
      "phone",
    );
    const desktop = prototypeDesignResponsiveFibonacciSteps(
      configured,
      8,
      "desktop",
    );

    expect(phone.filter((step) => step.visible)).toEqual([
      { multiplier: 3, visible: true },
    ]);
    expect(
      prototypeDesignFinerFibonacciSteps(phone).filter((step) => step.visible),
    ).toEqual([{ multiplier: 2, visible: true }]);
    expect(desktop.filter((step) => step.visible)).toEqual([
      { multiplier: 8, visible: true },
    ]);
  });

  test("colors grid violations with the matching Fibonacci increment", () => {
    const violation = renderToStaticMarkup(
      <PrototypeDesignGridViolationOverlay
        analysis={{
          cells: [
            {
              height: 2,
              key: "cell",
              left: 10,
              orientation: "vertical",
              size: 2,
              top: 10,
              width: 2,
            },
          ],
          layers: [],
        }}
        contrast={160}
        gridMode="fibonacci"
        gridSize={2}
      />,
    );

    expect(violation).toContain(
      "--prototype-design-grid-fibonacci-1-swatch",
    );
    expect(violation).toContain("--prototype-design-grid-violation-line");
  });

  test("dims everything outside the active box after a layer is approved", () => {
    const mask = renderToStaticMarkup(
      <PrototypeDesignFocusMask
        active={{
          bottom: 200,
          height: 160,
          left: 24,
          right: 336,
          top: 40,
          width: 312,
        }}
        dimmed
      />,
    );
    expect(mask).toContain('data-active="true"');
    expect(mask).toContain("prototype-design-tool__focus-mask");
  });

  test("marks only the visible edge overhang around an inner bounding box", () => {
    const inner = {
      bottom: 540,
      height: 40,
      left: 40,
      right: 320,
      top: 500,
      width: 280,
    };
    const regions = prototypeDesignCollisionRegions(inner, [
      {
        box: {
          bottom: 556,
          height: 68,
          left: 24,
          right: 336,
          top: 488,
          width: 312,
        },
        edges: { bottom: 0, left: 0, right: 0, top: 1 },
        label: "footer.modal__footer",
      },
    ]);

    expect(regions).toHaveLength(2);
    expect(
      regions.map(({ label, left, width }) => ({ label, left, width })),
    ).toEqual([
      { label: "16px", left: 24, width: 16 },
      { label: "16px", left: 320, width: 16 },
    ]);
  });

  test("highlights elements cut by an inner bounding-box line", () => {
    const inner = {
      bottom: 700,
      height: 68,
      left: 24,
      right: 340,
      top: 632,
      width: 316,
    };
    const regions = prototypeDesignCollisionRegions(inner, [
      {
        box: {
          bottom: 72,
          height: 24,
          left: 324,
          right: 348,
          top: 48,
          width: 24,
        },
        edges: { bottom: 1, left: 1, right: 1, top: 1 },
        label: "button.modal__close-trigger",
      },
    ]);

    expect(regions).toEqual([
      expect.objectContaining({
        height: 24,
        kind: "line-intersection",
        label: "line overlap",
        left: 324,
        top: 48,
        width: 24,
      }),
    ]);
  });

  test("marks both edges when two boxes share an exact alignment", () => {
    const inner = {
      bottom: 540,
      height: 40,
      left: 40,
      right: 320,
      top: 500,
      width: 280,
    };
    const regions = prototypeDesignAlignmentRegions(inner, [
      {
        box: {
          bottom: 140,
          height: 40,
          left: 40,
          right: 300,
          top: 100,
          width: 260,
        },
        edges: { bottom: 0, left: 0, right: 0, top: 0 },
        label: "button.project-row",
      },
    ]);

    expect(regions.filter((region) => region.kind === "box")).toEqual([
      expect.objectContaining({
        height: 40,
        left: 40,
        top: 100,
        width: 260,
      }),
      expect.objectContaining({
        height: 40,
        left: 40,
        top: 500,
        width: 280,
      }),
    ]);
    expect(regions.filter((region) => region.kind === "edge")).toEqual([
      expect.objectContaining({
        height: 40,
        left: 39,
        orientation: "vertical",
        top: 100,
        width: 2,
      }),
      expect.objectContaining({
        height: 40,
        left: 39,
        orientation: "vertical",
        top: 500,
        width: 2,
      }),
    ]);
  });

  test("shrinks the unapproved region at approved outer containers", () => {
    const target = {
      bottom: 800,
      height: 800,
      left: 0,
      right: 400,
      top: 0,
      width: 400,
    };
    const footer = {
      bottom: 776,
      height: 76,
      left: 24,
      right: 376,
      top: 700,
      width: 352,
    };
    expect(prototypeDesignApprovedBounds(target, [footer])).toEqual({
      ...target,
      bottom: 700,
      height: 700,
      left: 24,
      right: 376,
      width: 352,
    });

    const header = { ...footer, bottom: 96, top: 20 };
    expect(prototypeDesignApprovedBounds(target, [header])).toEqual({
      ...target,
      height: 704,
      left: 24,
      right: 376,
      top: 96,
      width: 352,
    });

    const middle = { ...footer, bottom: 438, top: 362 };
    expect(prototypeDesignApprovedBounds(target, [middle])).toEqual(target);
  });

  test("marks elements outside an approved anchor corridor", () => {
    const active = {
      bottom: 700,
      height: 700,
      left: 24,
      right: 376,
      top: 0,
      width: 352,
    };
    const regions = prototypeDesignBoundaryCollisionRegions(active, [
      {
        box: {
          bottom: 56,
          height: 32,
          left: 368,
          right: 400,
          top: 24,
          width: 32,
        },
        edges: { bottom: 1, left: 1, right: 1, top: 1 },
        label: "button.close",
      },
      {
        box: {
          bottom: 140,
          height: 40,
          left: 40,
          right: 360,
          top: 100,
          width: 320,
        },
        edges: { bottom: 0, left: 0, right: 0, top: 0 },
        label: "button.row",
      },
    ]);
    expect(regions).toEqual([
      expect.objectContaining({
        height: 32,
        kind: "boundary-overflow",
        left: 368,
        top: 24,
        width: 32,
      }),
    ]);
  });

  test("approves only one layer while keeping its descendants inspectable", () => {
    const measured = (label: string, top: number, bottom: number) => ({
      box: {
        bottom,
        height: bottom - top,
        left: 20,
        right: 380,
        top,
        width: 360,
      },
      edges: { bottom: 0, left: 0, right: 0, top: 0 },
      label,
    });
    const footer = measured("footer", 700, 780).box;
    const anchors = [
      measured("content", 120, 180),
      measured("footer button", 720, 750),
      measured("below", 790, 820),
    ];
    const active = {
      bottom: 700,
      height: 700,
      left: 0,
      right: 400,
      top: 0,
      width: 400,
    };
    expect(
      prototypeDesignUnapprovedAnchors(anchors, active, [footer]).map(
        (anchor) => anchor.label,
      ),
    ).toEqual(["content", "footer button"]);
  });

  test("renders the screen within the hardware shell", () => {
    const html = renderToStaticMarkup(
      <DeviceFrame
        orientation="portrait"
        viewport={prototypeViewportPresets.phone}
      >
        <div>Target app</div>
      </DeviceFrame>,
    );
    expect(html).toContain("prototype-device__hardware");
    expect(html).toContain("prototype-device__screen");
    expect(html).toContain("prototype-device__overlay");
    expect(html).toContain("Target app");

    const hiddenFrame = renderToStaticMarkup(
      <DeviceFrame
        orientation="portrait"
        showFrame={false}
        viewport={prototypeViewportPresets.phone}
      >
        <div>Target app</div>
      </DeviceFrame>,
    );
    expect(hiddenFrame).toContain('data-frame="hidden"');
    expect(hiddenFrame).toContain("prototype-device__overlay");

    const designTool = renderToStaticMarkup(
      <DeviceFrame
        designToolEnabled
        designToolGridSize={12}
        designToolUnit="rem"
        orientation="portrait"
        viewport={prototypeViewportPresets.phone}
      >
        <div>Inspectable app</div>
      </DeviceFrame>,
    );
    expect(designTool).toContain("prototype-design-tool--enabled");
    expect(designTool).toContain('data-grid-base="12"');
    expect(designTool).toContain('data-grid-size="48"');
    expect(designTool).toContain('data-grid-mode="linear"');
    expect(designTool).toContain('data-unit="rem"');
    expect(designTool).toContain("background-size:48px 48px");
    expect(designTool).toContain("Linear grid · Select an element · ⌥G closes");
    expect(designTool).toContain("prototype-design-tool__grid");
  });
});
