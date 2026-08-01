export const prototypeViewportKinds = ['phone', 'tablet', 'desktop'] as const;
export type PrototypeViewportKind = (typeof prototypeViewportKinds)[number];

export const prototypeOrientations = ['portrait', 'landscape'] as const;
export type PrototypeOrientation = (typeof prototypeOrientations)[number];

export const prototypeThemes = ['dark', 'light'] as const;
export type PrototypeTheme = (typeof prototypeThemes)[number];

export const prototypeSurfaceKinds = ['web', 'expo'] as const;
export type PrototypeSurfaceKind = (typeof prototypeSurfaceKinds)[number];

export const prototypeScenarioKinds = [
  'ready',
  'empty',
  'offline',
  'long-content',
  'branch-head-preview'
] as const;
export type PrototypeScenarioKind = (typeof prototypeScenarioKinds)[number];

export interface PrototypeViewportPreset {
  height: number;
  kind: PrototypeViewportKind;
  label: string;
  minimumScale: number;
  width: number;
}

export interface PrototypePresentation {
  fullscreen: boolean;
  orientation: PrototypeOrientation;
  showDeviceFrame: boolean;
  theme: PrototypeTheme;
}

export interface PrototypeSelection {
  scenario?: PrototypeScenarioKind;
  scenarioState: 'missing' | 'ready' | 'unknown';
  viewport: PrototypeViewportKind;
}

export const prototypeViewportPresets: Record<
  PrototypeViewportKind,
  PrototypeViewportPreset
> = {
  phone: {
    height: viewportConfig.phone.height,
    kind: 'phone',
    label: 'Phone',
    minimumScale: viewportConfig.phone.minimumScale,
    width: viewportConfig.phone.width
  },
  tablet: {
    height: viewportConfig.tablet.height,
    kind: 'tablet',
    label: 'Tablet',
    minimumScale: viewportConfig.tablet.minimumScale,
    width: viewportConfig.tablet.width
  },
  desktop: {
    height: viewportConfig.desktop.height,
    kind: 'desktop',
    label: 'Desktop',
    minimumScale: viewportConfig.desktop.minimumScale,
    width: viewportConfig.desktop.width
  }
};

export const prototypeScenarioLabels: Record<PrototypeScenarioKind, string> = {
  ready: 'Default',
  empty: 'Empty',
  offline: 'Offline',
  'long-content': 'Long content',
  'branch-head-preview': 'Branch head preview'
};

export function isPrototypeViewportKind(value: unknown): value is PrototypeViewportKind {
  return typeof value === 'string' &&
    prototypeViewportKinds.includes(value as PrototypeViewportKind);
}

export function isPrototypeScenarioKind(value: unknown): value is PrototypeScenarioKind {
  return typeof value === 'string' &&
    prototypeScenarioKinds.includes(value as PrototypeScenarioKind);
}

export function prototypeSelectionFromSearch(
  search: string,
  fallbackViewport: PrototypeViewportKind
): PrototypeSelection {
  const params = new URLSearchParams(search);
  const viewport = params.get('viewport');
  const scenario = params.get('scenario');
  const scenarioState = isPrototypeScenarioKind(scenario)
    ? 'ready'
    : scenario
      ? 'unknown'
      : 'missing';
  return {
    scenario: isPrototypeScenarioKind(scenario) ? scenario : undefined,
    scenarioState,
    viewport: isPrototypeViewportKind(viewport) ? viewport : fallbackViewport
  };
}

export function prototypeWorkspaceSelectionFromSearch(
  search: string,
  fallbackViewport: PrototypeViewportKind
): PrototypeSelection {
  const selection = prototypeSelectionFromSearch(search, fallbackViewport);
  if (selection.scenarioState !== 'missing') return selection;

  return {
    ...selection,
    scenario: prototypeScenarioKinds[0],
    scenarioState: 'ready'
  };
}

export function prototypePresentationFromSearch(
  search: string
): PrototypePresentation {
  const params = new URLSearchParams(search);
  return {
    fullscreen: params.get('fullscreen') === '1',
    orientation: params.get('orientation') === 'landscape'
      ? 'landscape'
      : 'portrait',
    showDeviceFrame: params.get('frame') !== '0',
    theme: params.get('theme') === 'light' ? 'light' : 'dark'
  };
}

export function prototypeSurfaceHref(
  surface: PrototypeSurfaceKind,
  viewport: PrototypeViewportKind,
  scenario: string,
  presentation: PrototypePresentation = {
    fullscreen: false,
    orientation: 'portrait',
    showDeviceFrame: true,
    theme: 'dark'
  }
) {
  const base = surface === 'web' ? '/prototype/desktop/' : '/prototype/mobile/';
  const query = new URLSearchParams({ scenario, viewport });
  if (!presentation.showDeviceFrame) query.set('frame', '0');
  if (presentation.fullscreen) query.set('fullscreen', '1');
  if (presentation.orientation === 'landscape') {
    query.set('orientation', 'landscape');
  }
  query.set('theme', presentation.theme);
  return `${base}?${query.toString()}`;
}
import viewportConfig from '../../config/prototype-viewports.json';
