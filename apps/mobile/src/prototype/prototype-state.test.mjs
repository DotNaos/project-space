import { describe, expect, test } from 'bun:test';

import {
  PROTOTYPE_VIEWPORTS,
  mobilePrototypeSearch,
  prototypePresentationSearch,
  prototypeDeviceScale,
  prototypeFitScale,
  readPrototypePresentation,
  readMobilePrototypeLocation,
  prototypeSearchFromUrl,
  webPrototypePath,
} from './prototype-state.ts';

const scenarioIds = ['populated', 'empty', 'dark-theme'];

describe('mobile prototype state', () => {
  test('uses exact central Phone, Tablet, and Desktop dimensions', () => {
    expect(PROTOTYPE_VIEWPORTS.phone).toMatchObject({
      height: 844,
      width: 390,
    });
    expect(PROTOTYPE_VIEWPORTS.tablet).toMatchObject({
      height: 1180,
      width: 820,
    });
    expect(PROTOTYPE_VIEWPORTS.desktop).toMatchObject({
      height: 900,
      width: 1440,
    });
  });

  test('restores valid URL state and fails closed for unknown Changes', () => {
    expect(
      readMobilePrototypeLocation(
        '?scenario=dark-theme&viewport=tablet',
        scenarioIds,
        'populated'
      )
    ).toEqual({
      scenarioId: 'dark-theme',
      scenarioState: 'ready',
      viewport: 'tablet',
    });

    expect(
      readMobilePrototypeLocation(
        '?scenario=unknown&viewport=desktop',
        scenarioIds,
        'populated'
      )
    ).toEqual({
      scenarioId: undefined,
      scenarioState: 'unknown',
      viewport: 'desktop',
    });
    expect(
      readMobilePrototypeLocation(
        '?viewport=phone',
        scenarioIds,
        'populated'
      )
    ).toEqual({
      scenarioId: undefined,
      scenarioState: 'missing',
      viewport: 'phone',
    });
  });

  test('preserves unrelated query values while updating prototype state', () => {
    expect(
      mobilePrototypeSearch('?source=preview', {
        scenarioId: 'empty',
        viewport: 'tablet',
      })
    ).toBe('?source=preview&scenario=empty&viewport=tablet');
    expect(webPrototypePath('error', 'phone')).toBe(
      '/prototype/desktop/?scenario=offline&viewport=phone'
    );
    expect(
      webPrototypePath(
        'error',
        'tablet',
        '?frame=0&fullscreen=1&source=preview'
      )
    ).toBe(
      '/prototype/desktop/?frame=0&fullscreen=1&source=preview&scenario=offline&viewport=tablet'
    );
  });

  test('reads and updates the independent presentation state', () => {
    expect(
      readPrototypePresentation(
        '?frame=0&fullscreen=1&orientation=landscape'
      )
    ).toEqual({
      fullscreen: true,
      orientation: 'landscape',
      showDeviceFrame: false,
      theme: 'dark',
    });
    expect(
      prototypePresentationSearch('?scenario=empty&viewport=phone', {
        fullscreen: true,
        orientation: 'landscape',
        showDeviceFrame: false,
        theme: 'light',
      })
    ).toBe(
      '?scenario=empty&viewport=phone&frame=0&fullscreen=1&orientation=landscape&theme=light'
    );
    expect(
      prototypePresentationSearch('?frame=0&fullscreen=1', {
        fullscreen: false,
        orientation: 'portrait',
        showDeviceFrame: true,
        theme: 'dark',
      })
    ).toBe('?theme=dark');
    expect(readPrototypePresentation('', 'light').theme).toBe('light');
  });

  test('reads presentation state from Expo and web launch URLs', () => {
    expect(
      prototypeSearchFromUrl(
        'exp://192.168.0.50:58484/?theme=dark&surface=native'
      )
    ).toBe('?theme=dark&surface=native');
    expect(
      prototypeSearchFromUrl(
        'https://example.test/prototype/mobile/?theme=light'
      )
    ).toBe('?theme=light');
    expect(prototypeSearchFromUrl('not a URL')).toBe('');
  });

  test('fits devices until their readable scale floor and rejects invalid input', () => {
    expect(
      prototypeDeviceScale({
        availableWidth: 414,
        frameWidth: 414,
        minimumScale: 0.75,
      })
    ).toBe(1);
    expect(
      prototypeDeviceScale({
        availableWidth: 207,
        frameWidth: 414,
        minimumScale: 0.75,
      })
    ).toBe(0.75);
    expect(
      prototypeDeviceScale({
        availableWidth: Number.NaN,
        frameWidth: 414,
        minimumScale: 0.75,
      })
    ).toBe(1);
  });

  test('fits the complete review device inside both canvas dimensions', () => {
    expect(
      prototypeFitScale({
        availableHeight: 540,
        availableWidth: 336,
        frameHeight: 1020,
        frameWidth: 1512,
      })
    ).toBeCloseTo(336 / 1512);
    expect(
      prototypeFitScale({
        availableHeight: 540,
        availableWidth: 500,
        frameHeight: 1180,
        frameWidth: 820,
      })
    ).toBeCloseTo(540 / 1180);
    expect(
      prototypeFitScale({
        availableHeight: Number.NaN,
        availableWidth: 336,
        frameHeight: 1020,
        frameWidth: 1512,
      })
    ).toBe(1);
  });
});
