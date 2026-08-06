import { useEffect, useRef, useState } from "react";
import { Button, Dropdown, Header, Separator, Tooltip } from "@heroui/react";
import {
  AppWindow,
  Check,
  ChevronDown,
  Eye,
  EyeOff,
  Globe2,
  Maximize2,
  Minimize2,
  Moon,
  Monitor,
  RotateCw,
  Ruler,
  ScanSearch,
  Smartphone,
  Sun,
  Tablet as TabletIcon,
  TriangleAlert,
} from "lucide-react";

import {
  prototypeSelectionFromSearch,
  prototypePresentationFromSearch,
  prototypeSurfaceHref,
  prototypeViewportKinds,
  prototypeViewportPresets,
  type PrototypePresentation,
  type PrototypeScenarioKind,
  type PrototypeTheme,
  type PrototypeViewportKind,
} from "../../../src/shared/prototype-canvas";
import { BranchHeadPrototype } from "../../../src/features/pr-preview-review/branch-head-prototype";
import { ProjectSpaceHome } from "./project-space-home";
import {
  PrototypeDisplaySettings,
  prototypeScreenBackgroundColor,
} from "./prototype-display-settings";
import { PrototypePreviewCarousel } from "./prototype-preview-carousel";
import {
  prototypeDesignAddFibonacciStep,
  prototypeDesignShowHighestFibonacciSteps,
  prototypeDesignToggleFibonacciStep,
} from "./prototype-design-grid-analysis";
import {
  PROTOTYPE_DESIGN_GRID_CONTRAST_MAX,
  PROTOTYPE_DESIGN_GRID_CONTRAST_MIN,
} from "./prototype-design-grid-controls";
import {
  isPrototypeDesignToggleShortcut,
  PROTOTYPE_DESIGN_GRID_MAX,
  PROTOTYPE_DESIGN_GRID_MIN,
  PrototypeDesignActions,
  PrototypeDesignSettings,
  PrototypeDesignStatus,
  type PrototypeDesignStatusSnapshot,
} from "./prototype-design-settings";
import { StandalonePrototypeReviewDock } from "./standalone-prototype-review-dock";
import { usePrototypeDesignPreferences } from "./use-prototype-design-preferences";
import "./prototype.css";
import "./prototype-design-tool.css";

const ROTATION_DURATION_MS = 360;
const ROTATION_CONTENT_HIDE_MS = 100;
const VIEWPORT_HIDE_MS = 120;
const VIEWPORT_SWAP_MS = 16;
function replaceSelection(
  viewport: PrototypeViewportKind,
  scenario: PrototypeScenarioKind,
  presentation: PrototypePresentation,
) {
  window.history.replaceState(
    {},
    "",
    prototypeSurfaceHref("web", viewport, scenario, presentation),
  );
}

function PrototypeTargetPicker({
  onSurfaceChange,
  onViewportChange,
  viewport,
}: {
  onSurfaceChange(value: "web" | "expo"): void;
  onViewportChange(value: PrototypeViewportKind): void;
  viewport: PrototypeViewportKind;
}) {
  const icons = {
    desktop: Monitor,
    phone: Smartphone,
    tablet: TabletIcon,
  };
  const ActiveIcon = icons[viewport];

  return (
    <Dropdown>
      <Dropdown.Trigger
        aria-label={`Prototype target: Web, ${prototypeViewportPresets[viewport].label}`}
        className="prototype-hud__picker"
      >
        <Globe2 aria-hidden className="size-3.5 shrink-0" />
        <span className="prototype-hud__picker-label">Web</span>
        <span aria-hidden className="prototype-hud__picker-separator">
          ·
        </span>
        <ActiveIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="prototype-hud__picker-label">
          {prototypeViewportPresets[viewport].label}
        </span>
        <ChevronDown aria-hidden className="size-3 shrink-0" />
      </Dropdown.Trigger>
      <Dropdown.Popover
        className="prototype-hud__popover"
        offset={6}
        placement="bottom left"
      >
        <Dropdown.Menu
          aria-label="Choose prototype target"
          onAction={(key) => {
            const next = String(key);
            if (next === "surface:web") onSurfaceChange("web");
            else if (next === "surface:expo") onSurfaceChange("expo");
            else if (next.startsWith("viewport:")) {
              const kind = next.slice("viewport:".length);
              if (
                prototypeViewportKinds.includes(kind as PrototypeViewportKind)
              ) {
                onViewportChange(kind as PrototypeViewportKind);
              }
            }
          }}
        >
          <Dropdown.Section>
            <Header className="prototype-hud__menu-header">Surface</Header>
            <Dropdown.Item
              className="prototype-hud__menu-item"
              id="surface:web"
              textValue="Web"
            >
              <Globe2 aria-hidden className="size-3.5 shrink-0" />
              <span className="flex-1">Web</span>
              <Check aria-hidden className="size-3.5 shrink-0" />
            </Dropdown.Item>
            <Dropdown.Item
              className="prototype-hud__menu-item"
              id="surface:expo"
              textValue="Native"
            >
              <AppWindow aria-hidden className="size-3.5 shrink-0" />
              <span className="flex-1">Native</span>
            </Dropdown.Item>
          </Dropdown.Section>
          <Separator className="prototype-hud__menu-separator" />
          <Dropdown.Section>
            <Header className="prototype-hud__menu-header">Viewport</Header>
            {prototypeViewportKinds.map((kind) => {
              const Icon = icons[kind];
              return (
                <Dropdown.Item
                  className="prototype-hud__menu-item"
                  id={`viewport:${kind}`}
                  key={kind}
                  textValue={prototypeViewportPresets[kind].label}
                >
                  <Icon aria-hidden className="size-3.5 shrink-0" />
                  <span className="flex-1">
                    {prototypeViewportPresets[kind].label}
                  </span>
                  {kind === viewport ? (
                    <Check aria-hidden className="size-3.5 shrink-0" />
                  ) : null}
                </Dropdown.Item>
              );
            })}
          </Dropdown.Section>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

function DesktopTarget({
  scenario,
  theme,
}: {
  scenario: PrototypeScenarioKind;
  theme: PrototypeTheme;
}) {
  if (scenario === "branch-head-preview") {
    return <BranchHeadPrototype theme={theme} />;
  }
  return <ProjectSpaceHome scenario={scenario} theme={theme} />;
}

function EmbeddedDesktopPrototype() {
  const initial = prototypeSelectionFromSearch(
    window.location.search,
    "desktop",
  );
  const presentation = prototypePresentationFromSearch(window.location.search);
  return (
    <main
      data-theme={presentation.theme}
      className={`prototype-embedded size-full min-h-0 overflow-auto ${
        initial.viewport === "phone" && presentation.orientation === "portrait"
          ? "pt-6"
          : initial.viewport === "phone"
            ? "pr-6"
            : ""
      }`}
    >
      {initial.scenario ? (
        <DesktopTarget scenario={initial.scenario} theme={presentation.theme} />
      ) : (
        <PrototypeSelectionUnavailable
          reason={initial.scenarioState}
          theme={presentation.theme}
        />
      )}
    </main>
  );
}

function PrototypeWorkspace() {
  const initial = prototypeSelectionFromSearch(
    window.location.search,
    "desktop",
  );
  const initialPresentation = prototypePresentationFromSearch(
    window.location.search,
  );
  const [viewport, setViewport] = useState<PrototypeViewportKind>(
    initial.viewport,
  );
  const [presentation, setPresentation] = useState(initialPresentation);
  const [hudVisible, setHudVisible] = useState(!initialPresentation.fullscreen);
  const {
    designToolEnabled,
    designToolFibonacciSteps,
    designToolGridContrast,
    designToolGridMode,
    designToolGridSize,
    designToolGridViolationsVisible,
    designToolUnit,
    setDesignToolEnabled,
    setDesignToolFibonacciSteps,
    setDesignToolGridContrast,
    setDesignToolGridMode,
    setDesignToolGridSize,
    setDesignToolGridViolationsVisible,
    setDesignToolUnit,
  } = usePrototypeDesignPreferences();
  const [designToolStatus, setDesignToolStatus] =
    useState<PrototypeDesignStatusSnapshot>({
      approvedAncestors: 0,
      canEnterLayer: false,
      currentScopeApproved: false,
      gridViolationEdges: 0,
      gridViolations: 0,
      guideViolations: 0,
      nextFix: null,
      remainingFixes: 0,
      scope: "selection",
      selected: false,
    });
  const [designToolAuditRequest, setDesignToolAuditRequest] = useState(0);
  const [isRotating, setIsRotating] = useState(false);
  const [isSwitchingViewport, setIsSwitchingViewport] = useState(false);
  const hideHudTimer = useRef<number | undefined>(undefined);
  const rotationTimer = useRef<number | undefined>(undefined);
  const viewportSwitchTimer = useRef<number | undefined>(undefined);
  const preset = prototypeViewportPresets[viewport];

  const cancelHudHide = () => {
    if (hideHudTimer.current === undefined) return;
    window.clearTimeout(hideHudTimer.current);
    hideHudTimer.current = undefined;
  };
  const scheduleHudHide = () => {
    cancelHudHide();
    hideHudTimer.current = window.setTimeout(() => {
      setHudVisible(false);
      hideHudTimer.current = undefined;
    }, 2800);
  };
  const revealHud = () => {
    setHudVisible(true);
    scheduleHudHide();
  };
  const updatePresentation = (next: PrototypePresentation) => {
    setPresentation(next);
    replaceSelection(viewport, "ready", next);
    if (next.fullscreen) {
      setHudVisible(false);
    } else {
      cancelHudHide();
      setHudVisible(true);
    }
  };

  const chooseViewport = (next: PrototypeViewportKind) => {
    if (next === viewport || isRotating || isSwitchingViewport) return;
    setIsSwitchingViewport(true);
    viewportSwitchTimer.current = window.setTimeout(() => {
      setViewport(next);
      replaceSelection(next, "ready", presentation);
      viewportSwitchTimer.current = window.setTimeout(() => {
        setIsSwitchingViewport(false);
        viewportSwitchTimer.current = undefined;
      }, VIEWPORT_SWAP_MS);
    }, VIEWPORT_HIDE_MS);
  };
  const chooseSurface = (next: "web" | "expo") => {
    if (next === "web") return;
    window.location.assign(
      prototypeSurfaceHref("expo", viewport, "populated", presentation),
    );
  };
  const rotateDevice = () => {
    if (viewport === "desktop" || isRotating || isSwitchingViewport) return;
    setIsRotating(true);
    rotationTimer.current = window.setTimeout(() => {
      updatePresentation({
        ...presentation,
        orientation:
          presentation.orientation === "portrait" ? "landscape" : "portrait",
      });
      rotationTimer.current = window.setTimeout(() => {
        setIsRotating(false);
        rotationTimer.current = undefined;
      }, ROTATION_DURATION_MS);
    }, ROTATION_CONTENT_HIDE_MS);
  };

  useEffect(() => {
    const toggleDesignTool = (event: KeyboardEvent) => {
      if (!isPrototypeDesignToggleShortcut(event)) return;
      event.preventDefault();
      event.stopPropagation();
      setDesignToolEnabled((enabled) => !enabled);
    };
    window.addEventListener("keydown", toggleDesignTool, true);
    return () => window.removeEventListener("keydown", toggleDesignTool, true);
  }, []);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("scenario") !== "ready") {
      replaceSelection(viewport, "ready", presentation);
    }
  }, []);

  useEffect(() => {
    const exitFullscreen = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !presentation.fullscreen) return;
      updatePresentation({ ...presentation, fullscreen: false });
    };
    window.addEventListener("keydown", exitFullscreen);
    return () => window.removeEventListener("keydown", exitFullscreen);
  });

  useEffect(() => {
    return () => {
      cancelHudHide();
      if (rotationTimer.current !== undefined) {
        window.clearTimeout(rotationTimer.current);
      }
      if (viewportSwitchTimer.current !== undefined) {
        window.clearTimeout(viewportSwitchTimer.current);
      }
    };
  }, []);

  return (
    <main className="prototype-app" data-theme={presentation.theme}>
      <section
        className="prototype-stage"
        data-fullscreen={presentation.fullscreen}
      >
        {presentation.fullscreen ? (
          <button
            aria-label="Show prototype controls"
            className="prototype-hud-edge"
            onFocus={revealHud}
            onMouseEnter={revealHud}
            onPointerDown={revealHud}
            type="button"
          />
        ) : null}
        <div
          className="prototype-hud-shell"
          data-design-active={designToolEnabled}
          data-react-aria-top-layer="true"
          data-visible={!presentation.fullscreen || hudVisible}
          data-testid="viewport-controls"
          onMouseEnter={cancelHudHide}
          onMouseLeave={presentation.fullscreen ? scheduleHudHide : undefined}
        >
          <div className="prototype-hud__surface">
            <PrototypeTargetPicker
              viewport={viewport}
              onSurfaceChange={chooseSurface}
              onViewportChange={chooseViewport}
            />
            <Button
              isIconOnly
              aria-label={
                presentation.showDeviceFrame
                  ? "Hide device frame"
                  : "Show device frame"
              }
              className="prototype-hud__frame"
              size="sm"
              variant="ghost"
              onPress={() => {
                updatePresentation({
                  ...presentation,
                  showDeviceFrame: !presentation.showDeviceFrame,
                });
              }}
            >
              {presentation.showDeviceFrame ? (
                <EyeOff className="size-4" />
              ) : (
                <Eye className="size-4" />
              )}
            </Button>
            <PrototypeDisplaySettings
              presentation={presentation}
              viewport={viewport}
              onChange={updatePresentation}
            />
            <Button
              isIconOnly
              aria-label={
                designToolEnabled ? "Hide design grid" : "Show design grid"
              }
              aria-pressed={designToolEnabled}
              className="prototype-hud__frame"
              data-active={designToolEnabled}
              size="sm"
              variant="ghost"
              onPress={() => setDesignToolEnabled((enabled) => !enabled)}
            >
              <Ruler className="size-4" />
            </Button>
            {designToolEnabled ? (
              <Tooltip closeDelay={0} delay={350}>
                <Button
                  isIconOnly
                  aria-label="Audit whole app"
                  aria-pressed={
                    designToolStatus.selected &&
                    designToolStatus.scope === "global"
                  }
                  className="prototype-hud__frame"
                  data-active={
                    designToolStatus.selected &&
                    designToolStatus.scope === "global"
                  }
                  size="sm"
                  variant="ghost"
                  onPress={() =>
                    setDesignToolAuditRequest((request) => request + 1)
                  }
                >
                  <ScanSearch className="size-4" />
                </Button>
                <Tooltip.Content placement="bottom">
                  Audit whole app
                </Tooltip.Content>
              </Tooltip>
            ) : null}
            {designToolEnabled ? (
              <Tooltip closeDelay={0} delay={350}>
                <Button
                  isIconOnly
                  aria-label={
                    designToolGridViolationsVisible
                      ? "Hide grid violations"
                      : "Show grid violations"
                  }
                  aria-pressed={designToolGridViolationsVisible}
                  className="prototype-hud__frame"
                  data-active={designToolGridViolationsVisible}
                  data-violation-toggle="true"
                  size="sm"
                  variant="ghost"
                  onPress={() =>
                    setDesignToolGridViolationsVisible((visible) => !visible)
                  }
                >
                  <TriangleAlert className="size-4" />
                </Button>
                <Tooltip.Content placement="bottom">
                  {designToolGridViolationsVisible
                    ? "Hide grid violations"
                    : "Show grid violations"}
                </Tooltip.Content>
              </Tooltip>
            ) : null}
            <PrototypeDesignSettings
              fibonacciSteps={designToolFibonacciSteps}
              gridContrast={designToolGridContrast}
              gridMode={designToolGridMode}
              gridSize={designToolGridSize}
              unit={designToolUnit}
              onGridModeChange={setDesignToolGridMode}
              onFibonacciStepAdd={() =>
                setDesignToolFibonacciSteps((steps) =>
                  prototypeDesignAddFibonacciStep(steps),
                )
              }
              onFibonacciStepDepthChange={(count) =>
                setDesignToolFibonacciSteps((steps) =>
                  prototypeDesignShowHighestFibonacciSteps(steps, count),
                )
              }
              onFibonacciStepToggle={(multiplier) =>
                setDesignToolFibonacciSteps((steps) =>
                  prototypeDesignToggleFibonacciStep(steps, multiplier),
                )
              }
              onGridContrastChange={(value) => {
                if (!Number.isFinite(value)) return;
                setDesignToolGridContrast(
                  Math.min(
                    PROTOTYPE_DESIGN_GRID_CONTRAST_MAX,
                    Math.max(PROTOTYPE_DESIGN_GRID_CONTRAST_MIN, value),
                  ),
                );
              }}
              onGridSizeChange={(value) => {
                if (!Number.isFinite(value)) return;
                setDesignToolGridSize(
                  Math.min(
                    PROTOTYPE_DESIGN_GRID_MAX,
                    Math.max(PROTOTYPE_DESIGN_GRID_MIN, value),
                  ),
                );
              }}
              onUnitChange={setDesignToolUnit}
            />
            {designToolEnabled ? (
              <div className="prototype-hud__design-row">
                <PrototypeDesignStatus
                  {...designToolStatus}
                  gridViolationsVisible={designToolGridViolationsVisible}
                />
                {designToolStatus.selected ? (
                  <PrototypeDesignActions
                    automatic={designToolStatus.scope === "global"}
                    canEnterLayer={designToolStatus.canEnterLayer}
                  />
                ) : null}
              </div>
            ) : null}
          </div>
          <div className="prototype-hud__actions">
            <Button
              isIconOnly
              aria-label={
                presentation.theme === "dark"
                  ? "Use light mode"
                  : "Use dark mode"
              }
              size="sm"
              variant="ghost"
              onPress={() => {
                updatePresentation({
                  ...presentation,
                  theme: presentation.theme === "dark" ? "light" : "dark",
                });
              }}
            >
              {presentation.theme === "dark" ? (
                <Sun className="size-4" />
              ) : (
                <Moon className="size-4" />
              )}
            </Button>
            <Button
              isDisabled={
                viewport === "desktop" || isRotating || isSwitchingViewport
              }
              isIconOnly
              aria-label="Rotate device"
              size="sm"
              variant="ghost"
              onPress={rotateDevice}
            >
              <RotateCw className="size-4" />
            </Button>
            <Button
              isIconOnly
              aria-label={
                presentation.fullscreen ? "Exit fullscreen" : "Enter fullscreen"
              }
              size="sm"
              variant="ghost"
              onPress={() => {
                updatePresentation({
                  ...presentation,
                  fullscreen: !presentation.fullscreen,
                });
              }}
            >
              {presentation.fullscreen ? (
                <Minimize2 className="size-4" />
              ) : (
                <Maximize2 className="size-4" />
              )}
            </Button>
          </div>
        </div>
        <PrototypePreviewCarousel
          designToolAuditRequest={designToolAuditRequest}
          designToolEnabled={designToolEnabled}
          designToolFibonacciSteps={designToolFibonacciSteps}
          designToolGridContrast={designToolGridContrast}
          designToolGridMode={designToolGridMode}
          designToolGridSize={designToolGridSize}
          designToolGridViolationsVisible={designToolGridViolationsVisible}
          designToolUnit={designToolUnit}
          fullscreen={presentation.fullscreen}
          isRotating={isRotating}
          isSwitchingViewport={isSwitchingViewport}
          onDesignToolSelectionChange={setDesignToolStatus}
          orientation={presentation.orientation}
          screenBackground={prototypeScreenBackgroundColor(
            presentation.screenBackground,
            presentation.theme,
          )}
          showDeviceFrame={presentation.showDeviceFrame}
          showSafeArea={presentation.showSafeArea}
          viewport={preset}
        >
          <DesktopTarget scenario="ready" theme={presentation.theme} />
        </PrototypePreviewCarousel>
        <StandalonePrototypeReviewDock theme={presentation.theme} />
      </section>
    </main>
  );
}

function PrototypeSelectionUnavailable({
  reason,
  theme,
}: {
  reason: "missing" | "ready" | "unknown";
  theme: PrototypeTheme;
}) {
  return (
    <section
      className={`grid size-full min-h-72 place-items-center px-8 text-center ${
        theme === "light"
          ? "bg-stone-50 text-neutral-900"
          : "bg-neutral-950 text-neutral-100"
      }`}
      role="alert"
    >
      <div className="max-w-sm">
        <Monitor aria-hidden className="mx-auto size-6 text-neutral-500" />
        <h1 className="mt-4 text-sm font-semibold">
          Prototype preview unavailable
        </h1>
        <p className="mt-2 text-xs leading-5 text-neutral-500">
          {reason === "unknown"
            ? "This prototype does not recognize the requested preview."
            : "Choose a preview from the prototype controls."}
        </p>
      </div>
    </section>
  );
}

export function PrototypeApp() {
  const embedded =
    new URLSearchParams(window.location.search).get("embedded") === "1";
  return embedded ? <EmbeddedDesktopPrototype /> : <PrototypeWorkspace />;
}
