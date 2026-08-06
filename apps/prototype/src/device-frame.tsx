import type { CSSProperties, ReactNode } from "react";

import desktopOverlayUrl from "../../../config/prototype-device-overlays/desktop.png?url";
import phoneOverlayUrl from "../../../config/prototype-device-overlays/phone.png?url";
import tabletOverlayUrl from "../../../config/prototype-device-overlays/tablet.png?url";
import { prototypeDeviceOverlayLayout } from "../../../src/shared/prototype-device-overlay";
import type {
  PrototypeOrientation,
  PrototypeViewportPreset,
} from "../../../src/shared/prototype-canvas";
import {
  PrototypeDesignTool,
  type PrototypeDesignUnit,
} from "./prototype-design-tool";
import type { PrototypeDesignStatusSnapshot } from "./prototype-design-settings";
import type {
  PrototypeDesignFibonacciStep,
  PrototypeDesignGridMode,
} from "./prototype-design-grid-analysis";

export interface DeviceFrameMetrics {
  frameHeight: number;
  frameWidth: number;
  outerHeight: number;
  outerWidth: number;
}

export interface PrototypeDeviceSafeAreaInsets {
  bottom: number;
  left: number;
  right: number;
  top: number;
}

export function prototypeDeviceSafeAreaInsets(
  kind: PrototypeViewportPreset["kind"],
  orientation: PrototypeOrientation,
  showFrame: boolean,
): PrototypeDeviceSafeAreaInsets {
  if (!showFrame || kind !== "phone") {
    return { bottom: 0, left: 0, right: 0, top: 0 };
  }
  return orientation === "landscape"
    ? { bottom: 21, left: 47, right: 47, top: 0 }
    : { bottom: 34, left: 0, right: 0, top: 48 };
}

const overlayUrls = {
  desktop: desktopOverlayUrl,
  phone: phoneOverlayUrl,
  tablet: tabletOverlayUrl,
} as const;

export function deviceFrameMetrics(
  viewport: PrototypeViewportPreset,
  orientation: PrototypeOrientation = "portrait",
): DeviceFrameMetrics {
  const overlay = prototypeDeviceOverlayLayout(
    viewport.kind,
    viewport.width,
    viewport.height,
    orientation,
  );
  return {
    frameHeight: overlay.outerHeight,
    frameWidth: overlay.outerWidth,
    outerHeight: overlay.outerHeight,
    outerWidth: overlay.outerWidth,
  };
}

export function DeviceFrame({
  children,
  designToolAuditRequest = 0,
  designToolGridContrast = 100,
  designToolEnabled = false,
  designToolFibonacciSteps,
  designToolGridMode = "linear",
  designToolGridSize = 2,
  onDesignToolSelectionChange,
  designToolUnit = "grid",
  designToolGridViolationsVisible = true,
  isRotating = false,
  orientation,
  screenBackground,
  showFrame = true,
  showSafeArea = false,
  viewport,
}: {
  children: ReactNode;
  designToolAuditRequest?: number;
  designToolGridContrast?: number;
  designToolEnabled?: boolean;
  designToolFibonacciSteps?: PrototypeDesignFibonacciStep[];
  designToolGridMode?: PrototypeDesignGridMode;
  designToolGridSize?: number;
  onDesignToolSelectionChange?(snapshot: PrototypeDesignStatusSnapshot): void;
  designToolUnit?: PrototypeDesignUnit;
  designToolGridViolationsVisible?: boolean;
  isRotating?: boolean;
  orientation: PrototypeOrientation;
  screenBackground?: string;
  showFrame?: boolean;
  showSafeArea?: boolean;
  viewport: PrototypeViewportPreset;
}) {
  const metrics = deviceFrameMetrics(viewport, orientation);
  const overlay = prototypeDeviceOverlayLayout(
    viewport.kind,
    viewport.width,
    viewport.height,
    orientation,
  );
  const outerHeight = showFrame ? metrics.outerHeight : overlay.screenHeight;
  const outerWidth = showFrame ? metrics.outerWidth : overlay.screenWidth;
  const safeArea = prototypeDeviceSafeAreaInsets(
    viewport.kind,
    orientation,
    showFrame,
  );
  const screenRadius = showFrame
    ? { desktop: 8, phone: 48, tablet: 24 }[viewport.kind]
    : 0;
  const style = {
    "--device-content-height": `${overlay.screenHeight - safeArea.top - safeArea.bottom}px`,
    "--device-content-width": `${overlay.screenWidth - safeArea.left - safeArea.right}px`,
    "--device-frame-height": `${metrics.frameHeight}px`,
    "--device-frame-width": `${metrics.frameWidth}px`,
    "--device-outer-height": `${outerHeight}px`,
    "--device-outer-width": `${outerWidth}px`,
    "--device-screen-height": `${overlay.screenHeight}px`,
    "--device-screen-left": `${showFrame ? overlay.screenLeft : 0}px`,
    "--device-screen-top": `${showFrame ? overlay.screenTop : 0}px`,
    "--device-screen-width": `${overlay.screenWidth}px`,
    "--device-screen-inset-bottom": `${safeArea.bottom}px`,
    "--device-screen-inset-left": `${safeArea.left}px`,
    "--device-screen-inset-right": `${safeArea.right}px`,
    "--device-screen-inset-top": `${safeArea.top}px`,
    "--device-screen-radius": `${screenRadius}px`,
    ...(screenBackground
      ? { "--prototype-screen-background": screenBackground }
      : {}),
  } as CSSProperties;

  return (
    <div
      className={`prototype-device prototype-device--${viewport.kind}`}
      data-device={viewport.kind}
      data-frame={showFrame ? "visible" : "hidden"}
      data-orientation={orientation}
      data-rotating={isRotating}
      style={{
        ...style,
        height: outerHeight,
        width: outerWidth,
      }}
    >
      <div
        className="prototype-device__hardware"
        style={{
          height: metrics.frameHeight,
          width: metrics.frameWidth,
        }}
      >
        <div
          className="prototype-device__screen @container"
          style={{
            background: screenBackground,
            height: overlay.screenHeight,
            left: showFrame ? overlay.screenLeft : 0,
            top: showFrame ? overlay.screenTop : 0,
            width: overlay.screenWidth,
          }}
        >
          <div className="prototype-device__content">
            {children}
            <PrototypeDesignTool
              auditRequest={designToolAuditRequest}
              enabled={designToolEnabled}
              fibonacciSteps={designToolFibonacciSteps}
              gridContrast={designToolGridContrast}
              gridMode={designToolGridMode}
              gridSize={designToolGridSize}
              onSelectionChange={onDesignToolSelectionChange}
              showGridViolations={designToolGridViolationsVisible}
              unit={designToolUnit}
              viewportKind={viewport.kind}
            />
          </div>
          {showSafeArea && viewport.kind === "phone" && showFrame ? (
            <div
              aria-hidden="true"
              className="prototype-device__safe-area"
              data-testid="safe-area-overlay"
            >
              <div className="prototype-device__safe-area-boundary" />
            </div>
          ) : null}
        </div>
        <img
          alt=""
          aria-hidden="true"
          className="prototype-device__overlay"
          draggable={false}
          src={overlayUrls[viewport.kind]}
          style={{
            height: overlay.overlayHeight,
            transform: `translate(-50%, -50%) rotate(${overlay.overlayRotation}deg)`,
            width: overlay.overlayWidth,
          }}
        />
      </div>
    </div>
  );
}
