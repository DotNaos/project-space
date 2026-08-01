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

describe("standalone prototype canvas", () => {
  test("uses centrally defined screen dimensions and includes the complete overlay in its fit bounds", () => {
    expect(prototypeViewportPresets.phone).toMatchObject({
      height: 844,
      width: 390,
    });
    expect(prototypeViewportPresets.tablet).toMatchObject({
      height: 1180,
      width: 820,
    });
    expect(prototypeViewportPresets.desktop).toMatchObject({
      height: 900,
      width: 1440,
    });

    const desktop = deviceFrameMetrics(prototypeViewportPresets.desktop);
    expect(desktop.outerHeight).toBe(desktop.frameHeight);
    expect(desktop.outerWidth).toBe(desktop.frameWidth);
    expect(desktop.outerHeight).toBeGreaterThan(900);
    expect(desktop.outerWidth).toBeGreaterThan(1440);
  });

  test("separates the target app from its viewport", () => {
    expect(prototypeSurfaceHref("web", "phone", "offline")).toBe(
      "/prototype/desktop/?scenario=offline&viewport=phone&theme=dark",
    );
    expect(prototypeSurfaceHref("expo", "desktop", "error")).toBe(
      "/prototype/mobile/?scenario=error&viewport=desktop&theme=dark",
    );
    expect(
      prototypeSelectionFromSearch(
        "?scenario=long-content&viewport=phone",
        "desktop",
      ),
    ).toEqual({
      scenario: "long-content",
      scenarioState: "ready",
      viewport: "phone",
    });
    expect(
      prototypeSelectionFromSearch(
        "?scenario=branch-head-preview&viewport=desktop",
        "phone",
      ),
    ).toEqual({
      scenario: "branch-head-preview",
      scenarioState: "ready",
      viewport: "desktop",
    });
    expect(prototypeSelectionFromSearch("?viewport=phone", "desktop")).toEqual({
      scenario: undefined,
      scenarioState: "missing",
      viewport: "phone",
    });
    expect(
      prototypeSelectionFromSearch("?scenario=unknown", "desktop"),
    ).toEqual({
      scenario: undefined,
      scenarioState: "unknown",
      viewport: "desktop",
    });
  });

  test("selects the first Change by default in the direct prototype workspace", () => {
    expect(
      prototypeWorkspaceSelectionFromSearch("?viewport=desktop", "phone"),
    ).toEqual({
      scenario: "ready",
      scenarioState: "ready",
      viewport: "desktop",
    });
  });

  test("keeps unknown direct-workspace Changes fail closed", () => {
    expect(
      prototypeWorkspaceSelectionFromSearch("?scenario=unknown", "desktop"),
    ).toEqual({
      scenario: undefined,
      scenarioState: "unknown",
      viewport: "desktop",
    });
  });

  test("preserves frame, fullscreen, rotation, and theme across app switches", () => {
    expect(
      prototypePresentationFromSearch(
        "?frame=0&fullscreen=1&orientation=landscape&theme=light",
      ),
    ).toEqual({
      fullscreen: true,
      orientation: "landscape",
      showDeviceFrame: false,
      theme: "light",
    });
    expect(
      prototypeSurfaceHref("expo", "tablet", "populated", {
        fullscreen: true,
        orientation: "landscape",
        showDeviceFrame: false,
        theme: "light",
      }),
    ).toBe(
      "/prototype/mobile/?scenario=populated&viewport=tablet&frame=0&fullscreen=1&orientation=landscape&theme=light",
    );
    const portrait = prototypeDeviceOverlayLayout("phone", 390, 844);
    const landscape = prototypeDeviceOverlayLayout(
      "phone",
      390,
      844,
      "landscape",
    );
    expect(landscape.outerWidth).toBe(portrait.outerHeight);
    expect(landscape.outerHeight).toBe(portrait.outerWidth);
    expect(landscape.screenWidth).toBe(844);
    expect(landscape.screenHeight).toBe(390);
  });

  test("keeps framed phone controls inside the rounded screen safe area", () => {
    expect(prototypeDeviceSafeAreaInsets("phone", "portrait", true)).toEqual({
      bottom: 24,
      left: 0,
      right: 0,
      top: 24,
    });
    expect(prototypeDeviceSafeAreaInsets("phone", "landscape", true)).toEqual({
      bottom: 20,
      left: 24,
      right: 24,
      top: 0,
    });
    expect(prototypeDeviceSafeAreaInsets("phone", "landscape", false)).toEqual({
      bottom: 0,
      left: 0,
      right: 0,
      top: 0,
    });

    const landscape = renderToStaticMarkup(
      <DeviceFrame
        orientation="landscape"
        showFrame
        viewport={prototypeViewportPresets.phone}
      >
        <div>Safe content</div>
      </DeviceFrame>,
    );
    expect(landscape).toContain("--device-content-width:796px");
    expect(landscape).toContain("--device-content-height:370px");
    expect(landscape).toContain("--device-screen-inset-left:24px");
    expect(landscape).toContain("--device-screen-inset-bottom:20px");
    expect(landscape).toContain("--device-screen-radius:48px");
  });

  test("always fits the complete device inside the available canvas", () => {
    expect(fitScale(250, 400, 1472, 964)).toBeCloseTo(250 / 1472);
    expect(fitScale(1200, 800, 1472, 964)).toBeCloseTo(1200 / 1472);
    expect(fitScale(2000, 1200, 1472, 964)).toBe(1);
  });

  test("formats ruler distances in pixels, rem, or the configured grid", () => {
    expect(formatPrototypeDesignMeasurement(16, 8, "px")).toBe("16px");
    expect(formatPrototypeDesignMeasurement(16, 8, "rem")).toBe("1rem");
    expect(formatPrototypeDesignMeasurement(16, 8, "grid")).toBe("2 grid");
    expect(formatPrototypeDesignMeasurement(15, 10, "grid")).toBe("1.5 grid");
  });

  test("uses flexible 4, 8, and 12-column presets", () => {
    expect(prototypeDesignResponsiveColumns(390)).toEqual({
      columnWidth: 80.5,
      count: 4,
      gutter: 12,
      margin: 16,
    });
    expect(prototypeDesignResponsiveColumns(796)).toEqual({
      columnWidth: 79.5,
      count: 8,
      gutter: 16,
      margin: 24,
    });
    expect(prototypeDesignResponsiveColumns(1440)).toEqual({
      columnWidth: 92.66666666666667,
      count: 12,
      gutter: 24,
      margin: 32,
    });

    const columns = renderToStaticMarkup(
      <PrototypeDesignGridBackdrop
        columns={prototypeDesignResponsiveColumns(390)}
        contrast={160}
        gridMode="fibonacci"
        gridSize={4}
        hint="4 responsive columns"
      />,
    );
    expect(columns).toContain('data-column-count="4"');
    expect(columns.match(/prototype-design-tool__column"/g)).toHaveLength(4);
    expect(columns).not.toContain("radial-gradient");
  });

});
