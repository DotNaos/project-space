import type { ReactNode } from "react";

import {
  type PrototypeOrientation,
  type PrototypeViewportPreset,
} from "../../../src/shared/prototype-canvas";
import { ScaledDeviceCanvas } from "./scaled-device-canvas";
import type { PrototypeDesignStatusSnapshot } from "./prototype-design-settings";
import type { PrototypeDesignUnit } from "./prototype-design-tool";
import type {
  PrototypeDesignFibonacciStep,
  PrototypeDesignGridMode,
} from "./prototype-design-grid-analysis";

export function PrototypePreviewCarousel({
  children,
  designToolAuditRequest = 0,
  designToolEnabled = false,
  designToolFibonacciSteps,
  designToolGridContrast = 100,
  designToolGridMode = "linear",
  designToolGridSize = 2,
  designToolUnit = "grid",
  fullscreen,
  isRotating,
  isSwitchingViewport,
  onDesignToolSelectionChange,
  designToolGridViolationsVisible = true,
  orientation,
  screenBackground,
  showDeviceFrame,
  viewport,
}: {
  children: ReactNode;
  designToolAuditRequest?: number;
  designToolEnabled?: boolean;
  designToolFibonacciSteps?: PrototypeDesignFibonacciStep[];
  designToolGridContrast?: number;
  designToolGridMode?: PrototypeDesignGridMode;
  designToolGridSize?: number;
  designToolUnit?: PrototypeDesignUnit;
  fullscreen: boolean;
  isRotating: boolean;
  isSwitchingViewport: boolean;
  onDesignToolSelectionChange?(snapshot: PrototypeDesignStatusSnapshot): void;
  designToolGridViolationsVisible?: boolean;
  orientation: PrototypeOrientation;
  screenBackground?: string;
  showDeviceFrame: boolean;
  viewport: PrototypeViewportPreset;
}) {
  return (
    <section
      aria-label="Current prototype"
      className="prototype-preview-carousel"
      data-testid="preview-carousel"
    >
      <ScaledDeviceCanvas
        designToolAuditRequest={designToolAuditRequest}
        designToolEnabled={designToolEnabled}
        designToolFibonacciSteps={designToolFibonacciSteps}
        designToolGridContrast={designToolGridContrast}
        designToolGridMode={designToolGridMode}
        designToolGridSize={designToolGridSize}
        onDesignToolSelectionChange={onDesignToolSelectionChange}
        designToolUnit={designToolUnit}
        designToolGridViolationsVisible={designToolGridViolationsVisible}
        fullscreen={fullscreen}
        isRotating={isRotating}
        isSwitchingViewport={isSwitchingViewport}
        orientation={orientation}
        screenBackground={screenBackground}
        showDeviceFrame={showDeviceFrame}
        viewport={viewport}
      >
        {children}
      </ScaledDeviceCanvas>
    </section>
  );
}
