import overlayConfig from '../../config/prototype-device-overlays.json';
import type { PrototypeOrientation } from './prototype-canvas';

export type PrototypeDeviceOverlayKind = keyof typeof overlayConfig;

export interface PrototypeDeviceOverlayLayout {
  overlayHeight: number;
  overlayRotation: 0 | 90;
  overlayWidth: number;
  outerHeight: number;
  outerWidth: number;
  screenHeight: number;
  screenLeft: number;
  screenTop: number;
  screenWidth: number;
}

export function prototypeDeviceOverlayLayout(
  kind: PrototypeDeviceOverlayKind,
  screenWidth: number,
  screenHeight: number,
  orientation: PrototypeOrientation = 'portrait'
): PrototypeDeviceOverlayLayout {
  const overlay = overlayConfig[kind];
  const horizontalScale = screenWidth / overlay.screen.width;
  const verticalScale = screenHeight / overlay.screen.height;
  const portrait = {
    outerHeight: overlay.image.height * verticalScale,
    outerWidth: overlay.image.width * horizontalScale,
    screenHeight,
    screenLeft: overlay.screen.x * horizontalScale,
    screenTop: overlay.screen.y * verticalScale,
    screenWidth
  };

  if (orientation === 'landscape' && kind !== 'desktop') {
    return {
      overlayHeight: portrait.outerHeight,
      overlayRotation: 90,
      overlayWidth: portrait.outerWidth,
      outerHeight: portrait.outerWidth,
      outerWidth: portrait.outerHeight,
      screenHeight: portrait.screenWidth,
      screenLeft:
        portrait.outerHeight - portrait.screenTop - portrait.screenHeight,
      screenTop: portrait.screenLeft,
      screenWidth: portrait.screenHeight
    };
  }

  return {
    overlayHeight: portrait.outerHeight,
    overlayRotation: 0,
    overlayWidth: portrait.outerWidth,
    ...portrait
  };
}
