import type { CSSProperties, ReactNode } from 'react';

import desktopOverlayUrl from '../../../config/prototype-device-overlays/desktop.png?url';
import phoneOverlayUrl from '../../../config/prototype-device-overlays/phone.png?url';
import tabletOverlayUrl from '../../../config/prototype-device-overlays/tablet.png?url';
import { prototypeDeviceOverlayLayout } from '../../../src/shared/prototype-device-overlay';
import type {
  PrototypeOrientation,
  PrototypeViewportPreset
} from '../../../src/shared/prototype-canvas';

export interface DeviceFrameMetrics {
  frameHeight: number;
  frameWidth: number;
  outerHeight: number;
  outerWidth: number;
}

const overlayUrls = {
  desktop: desktopOverlayUrl,
  phone: phoneOverlayUrl,
  tablet: tabletOverlayUrl
} as const;

export function deviceFrameMetrics(
  viewport: PrototypeViewportPreset,
  orientation: PrototypeOrientation = 'portrait'
): DeviceFrameMetrics {
  const overlay = prototypeDeviceOverlayLayout(
    viewport.kind,
    viewport.width,
    viewport.height,
    orientation
  );
  return {
    frameHeight: overlay.outerHeight,
    frameWidth: overlay.outerWidth,
    outerHeight: overlay.outerHeight,
    outerWidth: overlay.outerWidth
  };
}

export function DeviceFrame({
  children,
  isRotating = false,
  orientation,
  showFrame = true,
  viewport
}: {
  children: ReactNode;
  isRotating?: boolean;
  orientation: PrototypeOrientation;
  showFrame?: boolean;
  viewport: PrototypeViewportPreset;
}) {
  const metrics = deviceFrameMetrics(viewport, orientation);
  const overlay = prototypeDeviceOverlayLayout(
    viewport.kind,
    viewport.width,
    viewport.height,
    orientation
  );
  const outerHeight = showFrame ? metrics.outerHeight : overlay.screenHeight;
  const outerWidth = showFrame ? metrics.outerWidth : overlay.screenWidth;
  const style = {
    '--device-frame-height': `${metrics.frameHeight}px`,
    '--device-frame-width': `${metrics.frameWidth}px`,
    '--device-outer-height': `${outerHeight}px`,
    '--device-outer-width': `${outerWidth}px`,
    '--device-screen-height': `${overlay.screenHeight}px`,
    '--device-screen-left': `${showFrame ? overlay.screenLeft : 0}px`,
    '--device-screen-top': `${showFrame ? overlay.screenTop : 0}px`,
    '--device-screen-width': `${overlay.screenWidth}px`
  } as CSSProperties;

  return (
    <div
      className={`prototype-device prototype-device--${viewport.kind}`}
      data-device={viewport.kind}
      data-frame={showFrame ? 'visible' : 'hidden'}
      data-orientation={orientation}
      data-rotating={isRotating}
      style={{
        ...style,
        height: outerHeight,
        width: outerWidth
      }}
    >
      <div
        className="prototype-device__hardware"
        style={{
          height: metrics.frameHeight,
          width: metrics.frameWidth
        }}
      >
        <div
          className="prototype-device__screen @container"
          style={{
            height: overlay.screenHeight,
            left: showFrame ? overlay.screenLeft : 0,
            top: showFrame ? overlay.screenTop : 0,
            width: overlay.screenWidth
          }}
        >
          <div className="prototype-device__content">{children}</div>
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
            width: overlay.overlayWidth
          }}
        />
      </div>
    </div>
  );
}
