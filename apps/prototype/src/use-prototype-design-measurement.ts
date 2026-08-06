import { useCallback } from "react";

import {
  formatPrototypeDesignMeasurement,
  type PrototypeDesignUnit,
} from "./prototype-design-analysis";

export function usePrototypeDesignMeasurement(
  gridSize: number,
  unit: PrototypeDesignUnit,
) {
  const rootFontSize =
    typeof window === "undefined"
      ? 16
      : Number.parseFloat(
          window.getComputedStyle(document.documentElement).fontSize,
        );

  return useCallback(
    (pixels: number) =>
      formatPrototypeDesignMeasurement(
        pixels,
        gridSize,
        unit,
        Number.isFinite(rootFontSize) ? rootFontSize : 16,
      ),
    [gridSize, rootFontSize, unit],
  );
}
