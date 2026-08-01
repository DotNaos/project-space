import { Button, Label, Slider } from "@heroui/react";
import { Plus } from "lucide-react";

import {
  prototypeDesignFibonacciMultipliers,
  prototypeDesignGridLevels,
  type PrototypeDesignFibonacciStep,
  type PrototypeDesignGridMode,
} from "./prototype-design-grid-analysis";
import { prototypeDesignGridSwatchToken } from "./prototype-design-grid-palette";

export const PROTOTYPE_DESIGN_GRID_CONTRAST_MIN = 40;
export const PROTOTYPE_DESIGN_GRID_CONTRAST_MAX = 300;
export const PROTOTYPE_DESIGN_GRID_CONTRAST_DEFAULT = 160;

export function PrototypeDesignGridControls({
  contrast,
  fibonacciSteps,
  gridMode,
  gridSize,
  onContrastChange,
  onFibonacciStepAdd,
  onFibonacciStepDepthChange,
  onFibonacciStepToggle,
}: {
  contrast: number;
  fibonacciSteps: PrototypeDesignFibonacciStep[];
  gridMode: PrototypeDesignGridMode;
  gridSize: number;
  onContrastChange(value: number): void;
  onFibonacciStepAdd(): void;
  onFibonacciStepDepthChange(count: number): void;
  onFibonacciStepToggle(multiplier: number): void;
}) {
  const visibleStepCount = fibonacciSteps.filter((step) => step.visible).length;

  return (
    <>
      <div
        aria-label={`${gridMode === "fibonacci" ? "Fibonacci" : "Linear"} grid levels`}
        className="prototype-design-settings__grid-levels"
      >
        {gridMode === "fibonacci"
          ? fibonacciSteps.map((step, index) => (
              <Button
                aria-label={`${step.visible ? "Hide" : "Show"} Fibonacci level ${gridSize * step.multiplier} pixels`}
                aria-pressed={step.visible}
                className="prototype-design-settings__grid-level"
                data-visible={step.visible}
                isDisabled={step.visible && visibleStepCount === 1}
                key={step.multiplier}
                size="sm"
                variant="ghost"
                onPress={() => onFibonacciStepToggle(step.multiplier)}
              >
                <i
                  aria-hidden="true"
                  style={{
                    backgroundColor: prototypeDesignGridSwatchToken(
                      gridMode,
                      index,
                      fibonacciSteps.length,
                    ),
                  }}
                />
                <span>{gridSize * step.multiplier}px</span>
              </Button>
            ))
          : prototypeDesignGridLevels(gridSize, gridMode).map(
              (level, index, levels) => (
                <span key={level}>
                  <i
                    aria-hidden="true"
                    style={{
                      backgroundColor: prototypeDesignGridSwatchToken(
                        gridMode,
                        index,
                        levels.length,
                      ),
                    }}
                  />
                  {level}px
                </span>
              ),
            )}
        {gridMode === "fibonacci" ? (
          <Button
            isIconOnly
            aria-label="Add next Fibonacci level"
            className="prototype-design-settings__grid-level-add"
            isDisabled={
              fibonacciSteps.length >= prototypeDesignFibonacciMultipliers.length
            }
            size="sm"
            variant="ghost"
            onPress={onFibonacciStepAdd}
          >
            <Plus className="size-3" />
          </Button>
        ) : null}
      </div>
      {gridMode === "fibonacci" ? (
        <Slider
          aria-label="Visible Fibonacci levels"
          className="prototype-design-settings__slider prototype-design-settings__level-depth"
          maxValue={fibonacciSteps.length}
          minValue={1}
          step={1}
          value={visibleStepCount}
          onChange={(value) =>
            onFibonacciStepDepthChange(
              Array.isArray(value) ? value[0] : value,
            )
          }
        >
          <Label>Visible detail</Label>
          <Slider.Output>
            {visibleStepCount === 1
              ? "Highest only"
              : `${visibleStepCount} levels`}
          </Slider.Output>
          <Slider.Track className="prototype-design-settings__slider-track">
            <Slider.Fill className="prototype-design-settings__slider-fill" />
            <Slider.Thumb className="prototype-design-settings__slider-thumb" />
          </Slider.Track>
        </Slider>
      ) : null}
      <Slider
        aria-label="Grid contrast"
        className="prototype-design-settings__slider prototype-design-settings__contrast"
        maxValue={PROTOTYPE_DESIGN_GRID_CONTRAST_MAX}
        minValue={PROTOTYPE_DESIGN_GRID_CONTRAST_MIN}
        step={10}
        value={contrast}
        onChange={(value) =>
          onContrastChange(Array.isArray(value) ? value[0] : value)
        }
      >
        <Label>Grid contrast</Label>
        <Slider.Output>{contrast}%</Slider.Output>
        <Slider.Track className="prototype-design-settings__slider-track">
          <Slider.Fill className="prototype-design-settings__slider-fill" />
          <Slider.Thumb className="prototype-design-settings__slider-thumb" />
        </Slider.Track>
      </Slider>
      <span className="prototype-design-settings__contrast-note">
        Violation highlights use the matching grid-level color.
      </span>
    </>
  );
}
