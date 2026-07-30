import viewportConfig from '../../../../config/prototype-viewports.json';

export const PROTOTYPE_VIEWPORTS = {
  phone: {
    bezel: viewportConfig.phone.bezel,
    height: viewportConfig.phone.height,
    label: 'Phone',
    minimumScale: viewportConfig.phone.minimumScale,
    width: viewportConfig.phone.width,
  },
  tablet: {
    bezel: viewportConfig.tablet.bezel,
    height: viewportConfig.tablet.height,
    label: 'Tablet',
    minimumScale: viewportConfig.tablet.minimumScale,
    width: viewportConfig.tablet.width,
  },
  desktop: {
    bezel: 16,
    height: viewportConfig.desktop.height,
    label: 'Desktop',
    minimumScale: viewportConfig.desktop.minimumScale,
    width: viewportConfig.desktop.width,
  },
} as const;

export type PrototypeViewport = keyof typeof PROTOTYPE_VIEWPORTS;
export type PrototypeOrientation = 'landscape' | 'portrait';
export type PrototypeTheme = 'dark' | 'light';

export interface MobilePrototypeLocation {
  scenarioId: string;
  viewport: PrototypeViewport;
}

export interface PrototypePresentation {
  fullscreen: boolean;
  orientation: PrototypeOrientation;
  showDeviceFrame: boolean;
  theme: PrototypeTheme;
}

const DEFAULT_VIEWPORT: PrototypeViewport = 'phone';

export function isPrototypeViewport(
  value: string | null
): value is PrototypeViewport {
  return value === 'phone' || value === 'tablet' || value === 'desktop';
}

export function readMobilePrototypeLocation(
  search: string,
  scenarioIds: readonly string[],
  defaultScenarioId: string
): MobilePrototypeLocation {
  const params = new URLSearchParams(search);
  const requestedScenario = params.get('scenario');
  const requestedViewport = params.get('viewport');

  return {
    scenarioId:
      requestedScenario && scenarioIds.includes(requestedScenario)
        ? requestedScenario
        : defaultScenarioId,
    viewport: isPrototypeViewport(requestedViewport)
      ? requestedViewport
      : DEFAULT_VIEWPORT,
  };
}

export function mobilePrototypeSearch(
  currentSearch: string,
  state: MobilePrototypeLocation
) {
  const params = new URLSearchParams(currentSearch);
  params.set('scenario', state.scenarioId);
  params.set('viewport', state.viewport);
  return `?${params.toString()}`;
}

export function readPrototypePresentation(
  search: string,
  fallbackTheme: PrototypeTheme = 'dark'
): PrototypePresentation {
  const params = new URLSearchParams(search);
  return {
    fullscreen: params.get('fullscreen') === '1',
    orientation:
      params.get('orientation') === 'landscape' ? 'landscape' : 'portrait',
    showDeviceFrame: params.get('frame') !== '0',
    theme:
      params.get('theme') === 'light'
        ? 'light'
        : params.get('theme') === 'dark'
          ? 'dark'
          : fallbackTheme,
  };
}

export function prototypeSearchFromUrl(value: string | null | undefined) {
  if (!value) return '';
  try {
    return new URL(value).search;
  } catch {
    return '';
  }
}

export function prototypePresentationSearch(
  currentSearch: string,
  presentation: PrototypePresentation
) {
  const params = new URLSearchParams(currentSearch);
  if (presentation.showDeviceFrame) params.delete('frame');
  else params.set('frame', '0');
  if (presentation.fullscreen) params.set('fullscreen', '1');
  else params.delete('fullscreen');
  if (presentation.orientation === 'landscape') {
    params.set('orientation', 'landscape');
  } else {
    params.delete('orientation');
  }
  params.set('theme', presentation.theme);
  return `?${params.toString()}`;
}

export function webPrototypePath(
  scenarioId: string,
  viewport: PrototypeViewport,
  currentSearch = ''
) {
  let scenario = 'ready';
  if (scenarioId === 'empty') scenario = 'empty';
  if (scenarioId === 'error') scenario = 'offline';
  if (scenarioId === 'long-content') scenario = 'long-content';
  const params = new URLSearchParams(currentSearch);
  params.set('scenario', scenario);
  params.set('viewport', viewport);
  return `/prototype/desktop/?${params.toString()}`;
}

export function prototypeDeviceScale(input: {
  availableWidth: number;
  frameWidth: number;
  minimumScale: number;
}) {
  if (
    !Number.isFinite(input.availableWidth) ||
    !Number.isFinite(input.frameWidth) ||
    !Number.isFinite(input.minimumScale) ||
    input.availableWidth <= 0 ||
    input.frameWidth <= 0
  ) {
    return 1;
  }

  return Math.min(
    1,
    Math.max(input.minimumScale, input.availableWidth / input.frameWidth)
  );
}

export function prototypeFitScale(input: {
  availableHeight: number;
  availableWidth: number;
  frameHeight: number;
  frameWidth: number;
}) {
  const values = [
    input.availableHeight,
    input.availableWidth,
    input.frameHeight,
    input.frameWidth,
  ];
  if (
    values.some((value) => !Number.isFinite(value) || value <= 0)
  ) {
    return 1;
  }

  return Math.min(
    1,
    input.availableWidth / input.frameWidth,
    input.availableHeight / input.frameHeight
  );
}
