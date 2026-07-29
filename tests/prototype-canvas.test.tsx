import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  prototypePresentationFromSearch,
  prototypeSelectionFromSearch,
  prototypeSurfaceHref,
  prototypeViewportPresets
} from '../src/shared/prototype-canvas';
import { prototypeDeviceOverlayLayout } from '../src/shared/prototype-device-overlay';
import { deviceFrameMetrics, DeviceFrame } from '../apps/prototype/src/device-frame';
import { fitScale } from '../apps/prototype/src/scaled-device-canvas';

describe('standalone prototype canvas', () => {
  test('uses centrally defined screen dimensions and includes the complete overlay in its fit bounds', () => {
    expect(prototypeViewportPresets.phone).toMatchObject({ height: 844, width: 390 });
    expect(prototypeViewportPresets.tablet).toMatchObject({ height: 1180, width: 820 });
    expect(prototypeViewportPresets.desktop).toMatchObject({ height: 900, width: 1440 });

    const desktop = deviceFrameMetrics(prototypeViewportPresets.desktop);
    expect(desktop.outerHeight).toBe(desktop.frameHeight);
    expect(desktop.outerWidth).toBe(desktop.frameWidth);
    expect(desktop.outerHeight).toBeGreaterThan(900);
    expect(desktop.outerWidth).toBeGreaterThan(1440);
  });

  test('separates the target app from its viewport', () => {
    expect(prototypeSurfaceHref('web', 'phone', 'offline')).toBe(
      '/prototype/desktop/?scenario=offline&viewport=phone&theme=dark'
    );
    expect(prototypeSurfaceHref('expo', 'desktop', 'error')).toBe(
      '/prototype/mobile/?scenario=error&viewport=desktop&theme=dark'
    );
    expect(prototypeSelectionFromSearch('?scenario=long-content&viewport=phone', 'desktop'))
      .toEqual({ scenario: 'long-content', viewport: 'phone' });
  });

  test('preserves frame, fullscreen, rotation, and theme across app switches', () => {
    expect(
      prototypePresentationFromSearch(
        '?frame=0&fullscreen=1&orientation=landscape&theme=light'
      )
    ).toEqual({
      fullscreen: true,
      orientation: 'landscape',
      showDeviceFrame: false,
      theme: 'light'
    });
    expect(
      prototypeSurfaceHref('expo', 'tablet', 'populated', {
        fullscreen: true,
        orientation: 'landscape',
        showDeviceFrame: false,
        theme: 'light'
      })
    ).toBe(
      '/prototype/mobile/?scenario=populated&viewport=tablet&frame=0&fullscreen=1&orientation=landscape&theme=light'
    );
    const portrait = prototypeDeviceOverlayLayout('phone', 390, 844);
    const landscape = prototypeDeviceOverlayLayout(
      'phone',
      390,
      844,
      'landscape'
    );
    expect(landscape.outerWidth).toBe(portrait.outerHeight);
    expect(landscape.outerHeight).toBe(portrait.outerWidth);
    expect(landscape.screenWidth).toBe(844);
    expect(landscape.screenHeight).toBe(390);
  });

  test('always fits the complete device inside the available canvas', () => {
    expect(fitScale(250, 400, 1472, 964)).toBeCloseTo(250 / 1472);
    expect(fitScale(1200, 800, 1472, 964)).toBeCloseTo(1200 / 1472);
    expect(fitScale(2000, 1200, 1472, 964)).toBe(1);
  });

  test('renders the screen within the hardware shell', () => {
    const html = renderToStaticMarkup(
      <DeviceFrame
        orientation="portrait"
        viewport={prototypeViewportPresets.phone}
      >
        <div>Target app</div>
      </DeviceFrame>
    );
    expect(html).toContain('prototype-device__hardware');
    expect(html).toContain('prototype-device__screen');
    expect(html).toContain('prototype-device__overlay');
    expect(html).toContain('Target app');

    const hiddenFrame = renderToStaticMarkup(
      <DeviceFrame
        orientation="portrait"
        showFrame={false}
        viewport={prototypeViewportPresets.phone}
      >
        <div>Target app</div>
      </DeviceFrame>
    );
    expect(hiddenFrame).toContain('data-frame="hidden"');
    expect(hiddenFrame).toContain('prototype-device__overlay');
  });
});
