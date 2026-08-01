import {
  Button,
  Kbd,
  Label,
  ListBox,
  NumberField,
  Popover,
  Select,
  Slider,
  Toolbar,
  Tooltip,
} from "@heroui/react";
import {
  ArrowUpToLine,
  BadgeCheck,
  BadgeX,
  Eraser,
  Grid3X3,
  MousePointer2,
  Pin,
  RotateCcw,
  SlidersHorizontal,
} from "lucide-react";

import type { PrototypeDesignUnit } from "./prototype-design-analysis";
import type {
  PrototypeDesignFibonacciStep,
  PrototypeDesignGridMode,
} from "./prototype-design-grid-analysis";
import { PrototypeDesignGridControls } from "./prototype-design-grid-controls";
import "./prototype-design-settings.css";

const units: Array<{ label: string; value: PrototypeDesignUnit }> = [
  { label: "Pixels", value: "px" },
  { label: "REM", value: "rem" },
  { label: "Grid", value: "grid" },
];

export const PROTOTYPE_DESIGN_GRID_MIN = 1;
export const PROTOTYPE_DESIGN_GRID_MAX = 384;

export const tailwindSpacingPresets = [
  { pixels: 0, token: "0" },
  { pixels: 1, token: "px" },
  { pixels: 2, token: "0.5" },
  { pixels: 4, token: "1" },
  { pixels: 6, token: "1.5" },
  { pixels: 8, token: "2" },
  { pixels: 10, token: "2.5" },
  { pixels: 12, token: "3" },
  { pixels: 14, token: "3.5" },
  { pixels: 16, token: "4" },
  { pixels: 20, token: "5" },
  { pixels: 24, token: "6" },
  { pixels: 28, token: "7" },
  { pixels: 32, token: "8" },
  { pixels: 36, token: "9" },
  { pixels: 40, token: "10" },
  { pixels: 44, token: "11" },
  { pixels: 48, token: "12" },
  { pixels: 56, token: "14" },
  { pixels: 64, token: "16" },
  { pixels: 80, token: "20" },
  { pixels: 96, token: "24" },
  { pixels: 112, token: "28" },
  { pixels: 128, token: "32" },
  { pixels: 144, token: "36" },
  { pixels: 160, token: "40" },
  { pixels: 176, token: "44" },
  { pixels: 192, token: "48" },
  { pixels: 208, token: "52" },
  { pixels: 224, token: "56" },
  { pixels: 240, token: "60" },
  { pixels: 256, token: "64" },
  { pixels: 288, token: "72" },
  { pixels: 320, token: "80" },
  { pixels: 384, token: "96" },
] as const;

const usableTailwindSpacingPresets = tailwindSpacingPresets.slice(1);

function nearestTailwindPresetIndex(pixels: number) {
  return usableTailwindSpacingPresets.reduce(
    (nearest, preset, index) =>
      Math.abs(preset.pixels - pixels) <
      Math.abs(usableTailwindSpacingPresets[nearest].pixels - pixels)
        ? index
        : nearest,
    0,
  );
}

export const prototypeDesignShortcuts = [
  { action: "Pin guides at cursor", keys: ["P"] },
  { action: "Pin guides with mouse", keys: ["⌥", "Click"] },
  { action: "Clear all guides", keys: ["⇧", "P"] },
  { action: "Enter selected layer with a finer grid", keys: ["L"] },
  { action: "Remove grid from selected layer", keys: ["⇧", "L"] },
  { action: "Approve current layer", keys: ["A"] },
  { action: "Clear layer approvals", keys: ["⇧", "A"] },
  { action: "Select parent layer", keys: ["↑"] },
  { action: "Reset inspection", keys: ["Esc"] },
  { action: "Toggle design grid", keys: ["⌥", "G"] },
] as const;

export function isPrototypeDesignToggleShortcut(
  event: Pick<KeyboardEvent, "altKey" | "code" | "repeat">,
) {
  return event.altKey && event.code === "KeyG" && !event.repeat;
}

export interface PrototypeDesignStatusSnapshot {
  approvedAncestors: number;
  canEnterLayer: boolean;
  currentScopeApproved: boolean;
  gridViolationEdges: number;
  gridViolations: number;
  guideViolations: number;
  nextFix: string | null;
  remainingFixes: number;
  scope: "global" | "selection";
  selected: boolean;
}

const prototypeDesignActions = [
  { icon: Pin, key: "p", label: "Pin guides", shortcut: "P" },
  {
    icon: Eraser,
    key: "p",
    label: "Clear guides",
    shiftKey: true,
    shortcut: "⇧ P",
  },
  {
    icon: Grid3X3,
    key: "l",
    label: "Enter selected layer with a finer grid",
    shortcut: "L",
  },
  {
    icon: BadgeX,
    key: "l",
    label: "Remove grid from selected layer",
    shiftKey: true,
    shortcut: "⇧ L",
  },
  {
    icon: BadgeCheck,
    key: "a",
    label: "Approve current layer",
    shortcut: "A",
  },
  {
    icon: BadgeX,
    key: "a",
    label: "Clear layer approvals",
    shiftKey: true,
    shortcut: "⇧ A",
  },
  {
    icon: ArrowUpToLine,
    key: "ArrowUp",
    label: "Select parent layer",
    shortcut: "↑",
  },
  {
    icon: RotateCcw,
    key: "Escape",
    label: "Reset inspection",
    shortcut: "Esc",
  },
] as const;

export function PrototypeDesignActions({
  automatic = false,
  canEnterLayer = true,
}: {
  automatic?: boolean;
  canEnterLayer?: boolean;
}) {
  return (
    <Toolbar
      isAttached
      aria-label="Design tool actions"
      className="prototype-hud__design-actions"
    >
      {prototypeDesignActions.map((action) => {
        const Icon = action.icon;
        return (
          <Tooltip closeDelay={0} delay={350} key={action.label}>
            <Button
              isIconOnly
              aria-label={`${action.label} (${action.shortcut})`}
              className="prototype-hud__design-action"
              isDisabled={
                (automatic && ["a", "l", "ArrowUp"].includes(action.key)) ||
                (action.key === "l" &&
                  !("shiftKey" in action && action.shiftKey) &&
                  !canEnterLayer)
              }
              size="sm"
              variant="ghost"
              onPress={() => {
                window.dispatchEvent(
                  new KeyboardEvent("keydown", {
                    bubbles: true,
                    key: action.key,
                    shiftKey: "shiftKey" in action && action.shiftKey,
                  }),
                );
              }}
            >
              <Icon aria-hidden className="size-3.5" strokeWidth={1.75} />
            </Button>
            <Tooltip.Content
              className="prototype-hud__design-action-tooltip"
              placement="bottom"
            >
              <span>{action.label}</span>
              <span aria-hidden>{action.shortcut}</span>
            </Tooltip.Content>
          </Tooltip>
        );
      })}
    </Toolbar>
  );
}

export function PrototypeDesignStatus({
  approvedAncestors,
  currentScopeApproved,
  gridViolationEdges,
  gridViolations,
  gridViolationsVisible = true,
  guideViolations,
  nextFix,
  remainingFixes,
  scope,
  selected,
}: PrototypeDesignStatusSnapshot & { gridViolationsVisible?: boolean }) {
  const violationCount =
    (gridViolationsVisible ? gridViolations : 0) + guideViolations;
  const state = selected
    ? violationCount > 0
      ? "violations"
      : "clean"
    : "waiting";
  const layerLabel = `affected layer${gridViolations === 1 ? "" : "s"}`;
  const edgeLabel = `off-grid edge${gridViolationEdges === 1 ? "" : "s"}`;
  const guideLabel = `guide violation${guideViolations === 1 ? "" : "s"}`;

  return (
    <div
      aria-live="polite"
      className="prototype-hud__design-status"
      data-state={state}
      role="status"
    >
      <MousePointer2 aria-hidden className="size-3.5" />
      <span className="prototype-hud__design-status-mode">
        {selected && scope === "global"
          ? nextFix
            ? `Column audit · layer ${approvedAncestors + 1} · 1 of ${remainingFixes}`
            : "Column audit complete"
          : currentScopeApproved
          ? `Layer approved${approvedAncestors ? ` · ${approvedAncestors} parent${approvedAncestors === 1 ? "" : "s"} ✓` : ""}`
          : nextFix
            ? `Next fix · 1 of ${remainingFixes}`
            : selected && scope === "global"
              ? "Root review"
              : "Grid analysis"}
      </span>
      <span aria-hidden className="prototype-hud__design-status-separator">
        ·
      </span>
      <span className="prototype-hud__design-status-action">
        {selected
          ? currentScopeApproved
            ? "Choose the next layer and enter its finer grid"
            : nextFix ?? `${gridViolationsVisible ? `${gridViolations} ${layerLabel} · ${gridViolationEdges} ${edgeLabel}` : "Grid violations hidden"} · ${guideViolations} ${guideLabel}`
          : "Select an element"}
      </span>
    </div>
  );
}

export function PrototypeDesignSettings({
  gridContrast,
  fibonacciSteps,
  gridMode,
  gridSize,
  onGridModeChange,
  onGridContrastChange,
  onFibonacciStepAdd,
  onFibonacciStepDepthChange,
  onFibonacciStepToggle,
  onGridSizeChange,
  onUnitChange,
  unit,
}: {
  gridContrast: number;
  fibonacciSteps: PrototypeDesignFibonacciStep[];
  gridMode: PrototypeDesignGridMode;
  gridSize: number;
  onGridModeChange(value: PrototypeDesignGridMode): void;
  onGridContrastChange(value: number): void;
  onFibonacciStepAdd(): void;
  onFibonacciStepDepthChange(count: number): void;
  onFibonacciStepToggle(multiplier: number): void;
  onGridSizeChange(value: number): void;
  onUnitChange(value: PrototypeDesignUnit): void;
  unit: PrototypeDesignUnit;
}) {
  const selectedPreset = tailwindSpacingPresets.find(
    (preset) => preset.pixels === gridSize,
  );
  const presetIndex = nearestTailwindPresetIndex(gridSize);

  return (
    <Popover>
      <Button
        isIconOnly
        aria-label="Design grid settings"
        className="prototype-hud__frame"
        size="sm"
        variant="ghost"
      >
        <SlidersHorizontal className="size-4" />
      </Button>
      <Popover.Content
        className="prototype-design-settings"
        offset={6}
        placement="bottom left"
      >
        <Popover.Dialog className="prototype-design-settings__dialog">
          <Popover.Heading className="prototype-design-settings__heading">
            Ruler settings
          </Popover.Heading>
          <section className="prototype-design-settings__size">
            <Slider
              className="prototype-design-settings__slider"
              maxValue={usableTailwindSpacingPresets.length - 1}
              minValue={0}
              step={1}
              value={presetIndex}
              onChange={(value) => {
                const index = Array.isArray(value) ? value[0] : value;
                const preset = usableTailwindSpacingPresets[index];
                if (preset) onGridSizeChange(preset.pixels);
              }}
            >
              <Label>Grid size</Label>
              <Slider.Output>
                {selectedPreset
                  ? `Tailwind ${selectedPreset.token} · ${gridSize}px`
                  : `Custom · ${gridSize}px`}
              </Slider.Output>
              <Slider.Track className="prototype-design-settings__slider-track">
                <Slider.Fill className="prototype-design-settings__slider-fill" />
                <Slider.Thumb className="prototype-design-settings__slider-thumb" />
              </Slider.Track>
            </Slider>
            <div className="prototype-design-settings__size-fields">
              <Select
                fullWidth
                className="prototype-design-settings__preset"
                disabledKeys={["0"]}
                placeholder={`Custom · ${gridSize}px`}
                value={selectedPreset?.token ?? null}
                variant="secondary"
                onChange={(key) => {
                  const preset = tailwindSpacingPresets.find(
                    (option) => option.token === String(key),
                  );
                  if (preset?.pixels) onGridSizeChange(preset.pixels);
                }}
              >
                <Label>Tailwind preset</Label>
                <Select.Trigger>
                  <Select.Value>
                    {selectedPreset
                      ? `Tailwind ${selectedPreset.token} · ${gridSize}px`
                      : `Custom · ${gridSize}px`}
                  </Select.Value>
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover
                  className="prototype-design-settings__preset-popover"
                  placement="bottom start"
                >
                  <ListBox>
                    {tailwindSpacingPresets.map((preset) => (
                      <ListBox.Item
                        id={preset.token}
                        className="prototype-design-settings__preset-option"
                        key={preset.token}
                        textValue={`Tailwind ${preset.token}, ${preset.pixels} pixels`}
                      >
                        <span>Tailwind {preset.token}</span>
                        <span>{preset.pixels}px</span>
                      </ListBox.Item>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>
              <NumberField
                className="prototype-design-settings__field"
                maxValue={PROTOTYPE_DESIGN_GRID_MAX}
                minValue={PROTOTYPE_DESIGN_GRID_MIN}
                name="prototype-grid-size"
                step={1}
                value={gridSize}
                variant="secondary"
                onChange={(value) => onGridSizeChange(Math.round(value))}
              >
                <Label>Exact</Label>
                <NumberField.Group>
                  <NumberField.DecrementButton />
                  <NumberField.Input />
                  <span className="prototype-design-settings__suffix">px</span>
                  <NumberField.IncrementButton />
                </NumberField.Group>
              </NumberField>
            </div>
          </section>
          <div
            aria-label="Grid structure"
            className="prototype-design-settings__units"
            role="group"
          >
            <span className="prototype-design-settings__label">
              Grid structure
            </span>
            <div className="prototype-design-settings__unit-buttons [grid-template-columns:repeat(2,minmax(0,1fr))]">
              {(
                [
                  { label: "Linear", value: "linear" },
                  { label: "Fibonacci", value: "fibonacci" },
                ] as const
              ).map((option) => (
                <Button
                  aria-pressed={option.value === gridMode}
                  className="prototype-design-settings__unit"
                  data-active={option.value === gridMode}
                  key={option.value}
                  size="sm"
                  variant="ghost"
                  onPress={() => onGridModeChange(option.value)}
                >
                  {option.label}
                </Button>
              ))}
            </div>
            <PrototypeDesignGridControls
              contrast={gridContrast}
              fibonacciSteps={fibonacciSteps}
              gridMode={gridMode}
              gridSize={gridSize}
              onContrastChange={onGridContrastChange}
              onFibonacciStepAdd={onFibonacciStepAdd}
              onFibonacciStepDepthChange={onFibonacciStepDepthChange}
              onFibonacciStepToggle={onFibonacciStepToggle}
            />
          </div>
          <div
            aria-label="Measurement unit"
            className="prototype-design-settings__units"
            role="group"
          >
            <span className="prototype-design-settings__label">Units</span>
            <div className="prototype-design-settings__unit-buttons">
              {units.map((option) => (
                <Button
                  aria-pressed={option.value === unit}
                  className="prototype-design-settings__unit"
                  data-active={option.value === unit}
                  key={option.value}
                  size="sm"
                  variant="ghost"
                  onPress={() => onUnitChange(option.value)}
                >
                  {option.label}
                </Button>
              ))}
            </div>
          </div>
          <section
            aria-labelledby="prototype-design-shortcuts-heading"
            className="prototype-design-settings__shortcuts"
          >
            <div className="prototype-design-settings__shortcuts-header">
              <h3 id="prototype-design-shortcuts-heading">Shortcuts</h3>
              <span>Pointer snaps to the current grid size.</span>
            </div>
            <dl className="prototype-design-settings__shortcut-list">
              {prototypeDesignShortcuts.map((shortcut) => (
                <div
                  className="prototype-design-settings__shortcut"
                  key={shortcut.keys.join("-")}
                >
                  <dt>
                    <Kbd
                      aria-label={shortcut.keys.join(" plus ")}
                      className="prototype-design-settings__kbd"
                      variant="light"
                    >
                      <Kbd.Content>
                        <span className="prototype-design-settings__key-sequence">
                          {shortcut.keys.map((key) => (
                            <span
                              className="prototype-design-settings__key"
                              key={key}
                            >
                              {key}
                            </span>
                          ))}
                        </span>
                      </Kbd.Content>
                    </Kbd>
                  </dt>
                  <dd>{shortcut.action}</dd>
                </div>
              ))}
            </dl>
          </section>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}
