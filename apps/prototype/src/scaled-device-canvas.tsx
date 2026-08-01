import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import type {
  PrototypeOrientation,
  PrototypeViewportPreset,
} from "../../../src/shared/prototype-canvas";
import { DeviceFrame, deviceFrameMetrics } from "./device-frame";
import type { PrototypeDesignStatusSnapshot } from "./prototype-design-settings";
import type { PrototypeDesignUnit } from "./prototype-design-tool";
import type {
  PrototypeDesignFibonacciStep,
  PrototypeDesignGridMode,
} from "./prototype-design-grid-analysis";

function fitScale(
  availableWidth: number,
  availableHeight: number,
  frameWidth: number,
  frameHeight: number,
) {
  if (availableWidth <= 0 || availableHeight <= 0) return 1;
  return Math.min(
    1,
    availableWidth / frameWidth,
    availableHeight / frameHeight,
  );
}

export function ScaledDeviceCanvas({
  children,
  designToolAuditRequest = 0,
  designToolEnabled = false,
  designToolFibonacciSteps,
  designToolGridContrast = 100,
  designToolGridMode = "linear",
  designToolGridSize = 2,
  onDesignToolSelectionChange,
  designToolUnit = "grid",
  designToolGridViolationsVisible = true,
  fullscreen,
  isRotating = false,
  isSwitchingViewport = false,
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
  onDesignToolSelectionChange?(snapshot: PrototypeDesignStatusSnapshot): void;
  designToolUnit?: PrototypeDesignUnit;
  designToolGridViolationsVisible?: boolean;
  fullscreen: boolean;
  isRotating?: boolean;
  isSwitchingViewport?: boolean;
  orientation: PrototypeOrientation;
  screenBackground?: string;
  showDeviceFrame: boolean;
  viewport: PrototypeViewportPreset;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const landscape = orientation === "landscape" && viewport.kind !== "desktop";
  const screenHeight = landscape ? viewport.width : viewport.height;
  const screenWidth = landscape ? viewport.height : viewport.width;
  const metrics = deviceFrameMetrics(viewport, orientation);
  const renderDeviceFrame = showDeviceFrame && !fullscreen;
  const outerHeight = renderDeviceFrame ? metrics.outerHeight : screenHeight;
  const outerWidth = renderDeviceFrame ? metrics.outerWidth : screenWidth;

  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const update = () => {
      const bounds = element.getBoundingClientRect();
      const canvasInset = fullscreen ? 0 : 32;
      setScale(
        fitScale(
          Math.max(0, bounds.width - canvasInset),
          Math.max(0, bounds.height - canvasInset),
          outerWidth,
          outerHeight,
        ),
      );
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    update();
    return () => observer.disconnect();
  }, [fullscreen, outerHeight, outerWidth]);

  return (
    <div
      ref={host}
      className={`prototype-canvas${fullscreen ? " prototype-canvas--fullscreen" : ""}`}
      data-testid="device-canvas"
    >
      <div
        className="prototype-canvas__scaled"
        data-switching={isSwitchingViewport}
        style={{
          height: outerHeight * scale,
          width: outerWidth * scale,
        }}
      >
        <div
          className="origin-top-left"
          style={{ transform: `scale(${scale})` }}
        >
          <DeviceFrame
            designToolAuditRequest={designToolAuditRequest}
            designToolEnabled={designToolEnabled}
            designToolFibonacciSteps={designToolFibonacciSteps}
            designToolGridContrast={designToolGridContrast}
            designToolGridMode={designToolGridMode}
            designToolGridSize={designToolGridSize}
            onDesignToolSelectionChange={onDesignToolSelectionChange}
            designToolUnit={designToolUnit}
            designToolGridViolationsVisible={designToolGridViolationsVisible}
            isRotating={isRotating}
            orientation={orientation}
            screenBackground={screenBackground}
            showFrame={renderDeviceFrame}
            viewport={viewport}
          >
            {children}
          </DeviceFrame>
        </div>
      </div>
    </div>
  );
}

export { fitScale };
