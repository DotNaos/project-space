import { useState, type ReactNode } from 'react';
import {
  Image,
  ScrollView,
  type LayoutChangeEvent,
  type ImageSourcePropType,
  View,
} from 'react-native';

import { prototypeDeviceOverlayLayout } from '../../../../src/shared/prototype-device-overlay';
import {
  PROTOTYPE_VIEWPORTS,
  prototypeDeviceScale,
  prototypeFitScale,
  type PrototypeOrientation,
  type PrototypeViewport,
} from './prototype-state';

const overlayImages: Record<PrototypeViewport, ImageSourcePropType> = {
  desktop: require('../../../../config/prototype-device-overlays/desktop.png'),
  phone: require('../../../../config/prototype-device-overlays/phone.png'),
  tablet: require('../../../../config/prototype-device-overlays/tablet.png'),
};

export function PrototypeDeviceCanvas({
  children,
  fullscreen,
  isRotating = false,
  isSwitchingViewport = false,
  fitToCanvas = false,
  bottomInset = 0,
  orientation,
  showDeviceFrame,
  theme,
  viewport,
}: {
  children: ReactNode;
  fullscreen: boolean;
  isRotating?: boolean;
  isSwitchingViewport?: boolean;
  fitToCanvas?: boolean;
  bottomInset?: number;
  orientation: PrototypeOrientation;
  showDeviceFrame: boolean;
  theme: 'dark' | 'light';
  viewport: PrototypeViewport;
}) {
  const [canvasSize, setCanvasSize] = useState({ height: 0, width: 0 });
  const definition = PROTOTYPE_VIEWPORTS[viewport];
  const overlay = prototypeDeviceOverlayLayout(
    viewport,
    definition.width,
    definition.height,
    orientation
  );
  const renderDeviceFrame = showDeviceFrame && !fullscreen;
  const outerWidth = renderDeviceFrame
    ? overlay.outerWidth
    : overlay.screenWidth;
  const outerHeight = renderDeviceFrame
    ? overlay.outerHeight
    : overlay.screenHeight;
  const canvasInset = fullscreen ? 0 : 32;
  const availableWidth = Math.max(1, canvasSize.width - canvasInset);
  const availableHeight = Math.max(
    1,
    canvasSize.height - canvasInset - bottomInset
  );
  const scale = fullscreen || fitToCanvas
    ? prototypeFitScale({
        availableHeight,
        availableWidth,
        frameHeight: outerHeight,
        frameWidth: outerWidth,
      })
    : prototypeDeviceScale({
        availableWidth,
        frameWidth: outerWidth,
        minimumScale: definition.minimumScale,
      });
  const scaledWidth = Math.round(outerWidth * scale);
  const scaledHeight = Math.round(outerHeight * scale);
  function measureCanvas(event: LayoutChangeEvent) {
    const { height, width } = event.nativeEvent.layout;
    setCanvasSize({ height, width });
  }

  return (
    <View
      className={`min-h-0 flex-1 ${
        theme === 'dark' ? 'bg-black' : 'bg-white'
      }`}
      onLayout={measureCanvas}
      style={{ paddingBottom: bottomInset }}
    >
      <ScrollView
        className="min-h-0 flex-1"
        scrollEnabled={!fitToCanvas}
        contentContainerStyle={{
          minHeight: fullscreen
            ? Math.max(canvasSize.height, scaledHeight)
            : Math.max(canvasSize.height, scaledHeight + 48),
        }}
        nestedScrollEnabled
        showsVerticalScrollIndicator={!fitToCanvas}
      >
        <ScrollView
          contentContainerStyle={{
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: fullscreen
              ? Math.max(canvasSize.height, scaledHeight)
              : Math.max(canvasSize.height, scaledHeight + 48),
            minWidth: fitToCanvas
              ? Math.max(1, canvasSize.width)
              : Math.max(
                  canvasSize.width,
                  scaledWidth + (fullscreen ? 0 : 32)
                ),
            paddingHorizontal: fullscreen ? 0 : 16,
            paddingVertical: fullscreen ? 0 : 24,
          }}
          horizontal
          nestedScrollEnabled
          scrollEnabled={!fitToCanvas}
          showsHorizontalScrollIndicator={!fitToCanvas}
        >
          <View
            style={{
              height: scaledHeight,
              opacity: isSwitchingViewport ? 0 : 1,
              transitionDuration: isSwitchingViewport ? '100ms' : '160ms',
              transitionProperty: isSwitchingViewport
                ? 'opacity'
                : 'height, opacity, width',
              transitionTimingFunction: 'ease-out',
              width: scaledWidth,
            } as never}
          >
            <View
              accessibilityLabel={`${definition.label} ${
                renderDeviceFrame ? 'device frame' : 'screen'
              }`}
              style={{
                height: outerHeight,
                transform: [{ scale }],
                transformOrigin: 'top left',
                transitionDuration: isSwitchingViewport ? '0ms' : '360ms',
                transitionProperty: 'height, width, transform',
                transitionTimingFunction:
                  'cubic-bezier(0.4, 0, 0.2, 1)',
                width: outerWidth,
              } as never}
            >
              <View
                className="bg-transparent"
                style={{
                  height: overlay.outerHeight,
                  transitionDuration: isSwitchingViewport ? '0ms' : '360ms',
                  transitionProperty: 'height, width',
                  transitionTimingFunction:
                    'cubic-bezier(0.4, 0, 0.2, 1)',
                  width: overlay.outerWidth,
                } as never}
              >
                <View
                  className="absolute overflow-hidden"
                  style={{
                    borderRadius: !renderDeviceFrame
                      ? 0
                      : viewport === 'phone'
                        ? 44
                        : viewport === 'tablet'
                          ? 24
                          : 0,
                    height: overlay.screenHeight,
                    left: renderDeviceFrame ? overlay.screenLeft : 0,
                    paddingRight:
                      renderDeviceFrame &&
                      viewport === 'phone' &&
                      orientation === 'landscape'
                        ? 24
                        : 0,
                    paddingTop:
                      renderDeviceFrame &&
                      viewport === 'phone' &&
                      orientation === 'portrait'
                        ? 24
                        : 0,
                    top: renderDeviceFrame ? overlay.screenTop : 0,
                    transitionProperty:
                      'border-radius, height, left, padding, top, width',
                    transitionDuration: isSwitchingViewport ? '0ms' : '360ms',
                    transitionTimingFunction:
                      'cubic-bezier(0.4, 0, 0.2, 1)',
                    width: overlay.screenWidth,
                  } as never}
                >
                  <View
                    className="min-h-0 flex-1 bg-background"
                    style={{
                      opacity: isRotating ? 0 : 1,
                      transitionDuration: isRotating ? '80ms' : '140ms',
                      transitionProperty: 'opacity',
                      transitionTimingFunction: 'ease-out',
                    } as never}
                  >
                    {children}
                  </View>
                </View>
                <Image
                  accessibilityIgnoresInvertColors
                  resizeMode="stretch"
                  source={overlayImages[viewport]}
                  style={{
                    height: overlay.overlayHeight,
                    left: (overlay.outerWidth - overlay.overlayWidth) / 2,
                    opacity: renderDeviceFrame ? 1 : 0,
                    pointerEvents: 'none',
                    position: 'absolute',
                    top: (overlay.outerHeight - overlay.overlayHeight) / 2,
                    transform: [
                      { rotate: `${overlay.overlayRotation}deg` },
                    ],
                    transitionProperty: isRotating
                      ? 'height, opacity, transform, width'
                      : 'height, opacity, width',
                    transitionDuration: isSwitchingViewport ? '0ms' : '360ms',
                    transitionTimingFunction:
                      'cubic-bezier(0.4, 0, 0.2, 1)',
                    width: overlay.overlayWidth,
                  } as never}
                />
              </View>
            </View>
          </View>
        </ScrollView>
      </ScrollView>
    </View>
  );
}
