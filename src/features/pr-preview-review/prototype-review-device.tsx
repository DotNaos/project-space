import {
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode
} from 'react';

import desktopOverlayUrl from '../../../config/prototype-device-overlays/desktop.png?url';
import phoneOverlayUrl from '../../../config/prototype-device-overlays/phone.png?url';
import tabletOverlayUrl from '../../../config/prototype-device-overlays/tablet.png?url';
import { prototypeDeviceOverlayLayout } from '@/shared/prototype-device-overlay';
import {
  type PrototypeOrientation,
  type PrototypeTheme,
  prototypeViewportPresets,
  type PrototypeViewportPreset
} from '@/shared/prototype-canvas';

interface FrameMetrics {
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

const rotationTransition =
  '360ms cubic-bezier(0.4, 0, 0.2, 1)';

function frameMetrics(
  viewport: PrototypeViewportPreset,
  orientation: PrototypeOrientation
): FrameMetrics {
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

function fitScale(
  availableWidth: number,
  availableHeight: number,
  frameWidth: number,
  frameHeight: number,
  minimumScale: number
) {
  if (availableWidth <= 0 || availableHeight <= 0) return 1;
  return Math.max(
    minimumScale,
    Math.min(1, availableWidth / frameWidth, availableHeight / frameHeight)
  );
}

function DeviceHardware({
  children,
  isRotating,
  orientation,
  showFrame,
  theme,
  viewport
}: {
  children: ReactNode;
  isRotating: boolean;
  orientation: PrototypeOrientation;
  showFrame: boolean;
  theme: PrototypeTheme;
  viewport: PrototypeViewportPreset;
}) {
  const metrics = frameMetrics(viewport, orientation);
  const overlay = prototypeDeviceOverlayLayout(
    viewport.kind,
    viewport.width,
    viewport.height,
    orientation
  );
  const outerHeight = showFrame ? metrics.outerHeight : overlay.screenHeight;
  const outerWidth = showFrame ? metrics.outerWidth : overlay.screenWidth;
  return (
    <div
      aria-label={`${viewport.label} ${showFrame ? 'device frame' : 'screen'}`}
      className="relative"
      style={{
        height: outerHeight,
        transition: `height ${rotationTransition}, width ${rotationTransition}`,
        width: outerWidth
      }}
    >
      <div
        className="absolute overflow-hidden bg-transparent"
        style={{
          borderRadius:
            !showFrame
              ? 0
              : viewport.kind === 'phone'
              ? 44
              : viewport.kind === 'tablet'
                ? 24
                : 0,
          height: overlay.screenHeight,
          left: showFrame ? overlay.screenLeft : 0,
          top: showFrame ? overlay.screenTop : 0,
          transition:
            `border-radius ${rotationTransition}, height ${rotationTransition}, ` +
            `left ${rotationTransition}, top ${rotationTransition}, width ${rotationTransition}`,
          width: overlay.screenWidth
        }}
      >
        <div
          className={`size-full transition-opacity ease-out ${
            theme === 'dark' ? 'bg-neutral-950' : 'bg-stone-50'
          } ${
            isRotating
              ? 'pointer-events-none opacity-0 duration-75'
              : 'opacity-100 duration-150'
          }`}
        >
          {children}
        </div>
      </div>
      <img
        alt=""
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-1/2 select-none drop-shadow-[0_24px_36px_rgba(0,0,0,0.42)]"
        draggable={false}
        src={overlayUrls[viewport.kind]}
        style={{
          height: overlay.overlayHeight,
          opacity: showFrame ? 1 : 0,
          transform: `translate(-50%, -50%) rotate(${overlay.overlayRotation}deg)`,
          transition:
            `height ${rotationTransition}, opacity 180ms ease-out, ` +
            `transform ${rotationTransition}, width ${rotationTransition}`,
          width: overlay.overlayWidth
        }}
      />
    </div>
  );
}

export function PrototypeReviewDevice({
  children,
  fullscreen,
  isRotating = false,
  orientation,
  showDeviceFrame,
  theme,
  viewportKind
}: {
  children: ReactNode;
  fullscreen: boolean;
  isRotating?: boolean;
  orientation: PrototypeOrientation;
  showDeviceFrame: boolean;
  theme: PrototypeTheme;
  viewportKind: keyof typeof prototypeViewportPresets;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const viewport = prototypeViewportPresets[viewportKind];
  const overlay = prototypeDeviceOverlayLayout(
    viewport.kind,
    viewport.width,
    viewport.height,
    orientation
  );
  const metrics = frameMetrics(viewport, orientation);
  const renderDeviceFrame = showDeviceFrame && !fullscreen;
  const outerHeight = renderDeviceFrame
    ? metrics.outerHeight
    : overlay.screenHeight;
  const outerWidth = renderDeviceFrame ? metrics.outerWidth : overlay.screenWidth;

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
      className={`min-h-0 min-w-0 flex-1 ${
        theme === 'dark' ? 'bg-black' : 'bg-white'
      } ${
        fullscreen
          ? 'flex items-center justify-center overflow-hidden'
          : 'flex overflow-auto p-4'
      }`}
    >
      <div
        className="relative m-auto"
        style={{
          height: outerHeight * scale,
          transition: `height ${rotationTransition}, width ${rotationTransition}`,
          width: outerWidth * scale
        }}
      >
        <div
          className="origin-top-left"
          style={{
            transform: `scale(${scale})`,
            transition: `transform ${rotationTransition}`
          }}
        >
          <DeviceHardware
            isRotating={isRotating}
            orientation={orientation}
            showFrame={renderDeviceFrame}
            theme={theme}
            viewport={viewport}
          >
            {children}
          </DeviceHardware>
        </div>
      </div>
    </div>
  );
}
