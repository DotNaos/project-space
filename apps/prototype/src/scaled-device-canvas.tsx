import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import type {
  PrototypeOrientation,
  PrototypeViewportPreset
} from '../../../src/shared/prototype-canvas';
import { DeviceFrame, deviceFrameMetrics } from './device-frame';

function fitScale(
  availableWidth: number,
  availableHeight: number,
  frameWidth: number,
  frameHeight: number,
  minimumScale = 0
) {
  if (availableWidth <= 0 || availableHeight <= 0) return 1;
  return Math.max(
    minimumScale,
    Math.min(1, availableWidth / frameWidth, availableHeight / frameHeight)
  );
}

export function ScaledDeviceCanvas({
  children,
  fullscreen,
  isRotating = false,
  isSwitchingViewport = false,
  orientation,
  showDeviceFrame,
  viewport
}: {
  children: ReactNode;
  fullscreen: boolean;
  isRotating?: boolean;
  isSwitchingViewport?: boolean;
  orientation: PrototypeOrientation;
  showDeviceFrame: boolean;
  viewport: PrototypeViewportPreset;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(viewport.minimumScale);
  const landscape = orientation === 'landscape' && viewport.kind !== 'desktop';
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
      setScale(fitScale(
        Math.max(0, bounds.width - canvasInset),
        Math.max(0, bounds.height - canvasInset),
        outerWidth,
        outerHeight,
        viewport.minimumScale
      ));
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    update();
    return () => observer.disconnect();
  }, [
    fullscreen,
    outerHeight,
    outerWidth,
    viewport.minimumScale
  ]);

  return (
    <div
      ref={host}
      className={`prototype-canvas${fullscreen ? ' prototype-canvas--fullscreen' : ''}`}
      data-testid="device-canvas"
    >
      <div
        className="prototype-canvas__scaled"
        data-switching={isSwitchingViewport}
        style={{
          height: outerHeight * scale,
          width: outerWidth * scale
        }}
      >
        <div
          className="origin-top-left"
          style={{ transform: `scale(${scale})` }}
        >
          <DeviceFrame
            isRotating={isRotating}
            orientation={orientation}
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
