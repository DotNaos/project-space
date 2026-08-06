import { useEffect, useState } from "react";

import type { PrototypeDesignUnit } from "./prototype-design-analysis";
import {
  prototypeDesignDefaultFibonacciSteps,
  prototypeDesignFibonacciMultipliers,
  prototypeDesignShowHighestFibonacciSteps,
  type PrototypeDesignFibonacciStep,
  type PrototypeDesignGridMode,
} from "./prototype-design-grid-analysis";
import {
  PROTOTYPE_DESIGN_GRID_CONTRAST_DEFAULT,
  PROTOTYPE_DESIGN_GRID_CONTRAST_MAX,
  PROTOTYPE_DESIGN_GRID_CONTRAST_MIN,
} from "./prototype-design-grid-controls";
import {
  PROTOTYPE_DESIGN_GRID_MAX,
  PROTOTYPE_DESIGN_GRID_MIN,
} from "./prototype-design-settings";

const storageKeys = {
  contrast: "prototype-design-grid-contrast",
  enabled: "prototype-design-tool",
  fibonacciSteps: "prototype-design-fibonacci-steps",
  gridMode: "prototype-design-grid-mode",
  hierarchy: "prototype-design-grid-hierarchy-v1",
  gridSize: "prototype-design-grid-size-v2",
  unit: "prototype-design-unit",
  violations: "prototype-design-grid-violations",
} as const;

function storedNumber(key: string, fallback: number, min: number, max: number) {
  const value = Number.parseInt(
    window.localStorage.getItem(key) ?? String(fallback),
    10,
  );
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function storedUnit(): PrototypeDesignUnit {
  const value = window.localStorage.getItem(storageKeys.unit);
  return value === "px" || value === "rem" || value === "grid" ? value : "grid";
}

function storedFibonacciSteps(): PrototypeDesignFibonacciStep[] {
  try {
    const value = JSON.parse(
      window.localStorage.getItem(storageKeys.fibonacciSteps) ?? "null",
    );
    if (!Array.isArray(value) || value.length === 0) {
      return prototypeDesignDefaultFibonacciSteps();
    }
    const visibility = value
      .slice(0, prototypeDesignFibonacciMultipliers.length)
      .map(Boolean);
    if (window.localStorage.getItem(storageKeys.hierarchy) !== "enabled") {
      visibility.fill(false);
      visibility[visibility.length - 1] = true;
    } else if (!visibility.some(Boolean)) {
      visibility[visibility.length - 1] = true;
    }
    return prototypeDesignFibonacciMultipliers
      .slice(0, visibility.length)
      .map((multiplier, index) => ({
        multiplier,
        visible: visibility[index],
      }));
  } catch {
    return prototypeDesignDefaultFibonacciSteps();
  }
}

export function usePrototypeDesignPreferences() {
  const [enabled, setEnabled] = useState(
    () => window.localStorage.getItem(storageKeys.enabled) === "enabled",
  );
  const [gridContrast, setGridContrast] = useState(() =>
    storedNumber(
      storageKeys.contrast,
      PROTOTYPE_DESIGN_GRID_CONTRAST_DEFAULT,
      PROTOTYPE_DESIGN_GRID_CONTRAST_MIN,
      PROTOTYPE_DESIGN_GRID_CONTRAST_MAX,
    ),
  );
  const [fibonacciSteps, setFibonacciSteps] = useState(storedFibonacciSteps);
  const [gridMode, setGridMode] = useState<PrototypeDesignGridMode>(() =>
    window.localStorage.getItem(storageKeys.gridMode) === "linear"
      ? "linear"
      : "fibonacci",
  );
  const [gridSize, setGridSize] = useState(() =>
    storedNumber(
      storageKeys.gridSize,
      2,
      PROTOTYPE_DESIGN_GRID_MIN,
      PROTOTYPE_DESIGN_GRID_MAX,
    ),
  );
  const [unit, setUnit] = useState<PrototypeDesignUnit>(storedUnit);
  const [violationsVisible, setViolationsVisible] = useState(
    () => window.localStorage.getItem(storageKeys.violations) !== "hidden",
  );

  useEffect(() => {
    if (window.localStorage.getItem(storageKeys.hierarchy) !== "enabled") {
      window.localStorage.setItem(storageKeys.hierarchy, "enabled");
      setFibonacciSteps((current) =>
        prototypeDesignShowHighestFibonacciSteps(current, 1),
      );
      return;
    }
    window.localStorage.setItem(
      storageKeys.enabled,
      enabled ? "enabled" : "disabled",
    );
    window.localStorage.setItem(storageKeys.contrast, String(gridContrast));
    window.localStorage.setItem(
      storageKeys.fibonacciSteps,
      JSON.stringify(fibonacciSteps.map((step) => step.visible)),
    );
    window.localStorage.setItem(storageKeys.gridMode, gridMode);
    window.localStorage.setItem(storageKeys.gridSize, String(gridSize));
    window.localStorage.setItem(storageKeys.unit, unit);
    window.localStorage.setItem(
      storageKeys.violations,
      violationsVisible ? "visible" : "hidden",
    );
  }, [
    enabled,
    fibonacciSteps,
    gridContrast,
    gridMode,
    gridSize,
    unit,
    violationsVisible,
  ]);

  return {
    designToolEnabled: enabled,
    designToolFibonacciSteps: fibonacciSteps,
    designToolGridContrast: gridContrast,
    designToolGridMode: gridMode,
    designToolGridSize: gridSize,
    designToolGridViolationsVisible: violationsVisible,
    designToolUnit: unit,
    setDesignToolEnabled: setEnabled,
    setDesignToolFibonacciSteps: setFibonacciSteps,
    setDesignToolGridContrast: setGridContrast,
    setDesignToolGridMode: setGridMode,
    setDesignToolGridSize: setGridSize,
    setDesignToolGridViolationsVisible: setViolationsVisible,
    setDesignToolUnit: setUnit,
  };
}
