import { useEffect, useMemo, useRef, useState, type Key } from 'react';
import { Button, Tabs } from '@heroui/react';
import {
  AppWindow,
  Eye,
  EyeOff,
  Globe2,
  Laptop,
  Maximize2,
  Minimize2,
  Moon,
  Monitor,
  RotateCw,
  Smartphone,
  Sun,
  Tablet as TabletIcon
} from 'lucide-react';

import { ProjectRootSummary } from '../../../src/features/project-desktop/components/project-root-summary';
import {
  prototypeSelectionFromSearch,
  prototypePresentationFromSearch,
  prototypeSurfaceHref,
  prototypeViewportKinds,
  prototypeViewportPresets,
  type PrototypePresentation,
  type PrototypeScenarioKind,
  type PrototypeTheme,
  type PrototypeViewportKind
} from '../../../src/shared/prototype-canvas';
import { desktopPrototypeScenario } from './desktop-prototype-scenarios';
import { ScaledDeviceCanvas } from './scaled-device-canvas';
import './prototype.css';

const ROTATION_DURATION_MS = 360;
const ROTATION_CONTENT_HIDE_MS = 100;
const VIEWPORT_HIDE_MS = 120;
const VIEWPORT_SWAP_MS = 16;

function replaceSelection(
  viewport: PrototypeViewportKind,
  scenario: PrototypeScenarioKind,
  presentation: PrototypePresentation
) {
  window.history.replaceState(
    {},
    '',
    prototypeSurfaceHref('web', viewport, scenario, presentation)
  );
}

function mobileScenarioFor(scenario: PrototypeScenarioKind) {
  if (scenario === 'empty') return 'empty';
  if (scenario === 'offline') return 'error';
  if (scenario === 'long-content') return 'long-content';
  return 'populated';
}

function SurfaceTabs({
  onChange
}: {
  onChange(value: 'web' | 'expo'): void;
}) {
  return (
    <Tabs
      aria-label="Prototype app"
      selectedKey="web"
      variant="primary"
      onSelectionChange={(key: Key) => {
        if (key === 'web' || key === 'expo') onChange(key);
      }}
    >
      <Tabs.ListContainer>
        <Tabs.List aria-label="Prototype app">
          <Tabs.Tab id="web">
            <span className="inline-flex items-center gap-2">
              <Globe2 aria-hidden className="size-3.5 shrink-0" />
              Web
            </span>
          </Tabs.Tab>
          <Tabs.Tab id="expo">
            <span className="inline-flex items-center gap-2">
              <AppWindow aria-hidden className="size-3.5 shrink-0" />
              Native
            </span>
          </Tabs.Tab>
        </Tabs.List>
      </Tabs.ListContainer>
    </Tabs>
  );
}

function ViewportTabs({
  onChange,
  viewport
}: {
  onChange(value: PrototypeViewportKind): void;
  viewport: PrototypeViewportKind;
}) {
  const icons = {
    desktop: Monitor,
    phone: Smartphone,
    tablet: TabletIcon
  };

  return (
    <Tabs
      aria-label="Prototype device"
      selectedKey={viewport}
      variant="primary"
      onSelectionChange={(key: Key) => {
        if (typeof key === 'string' && prototypeViewportKinds.includes(key as PrototypeViewportKind)) {
          onChange(key as PrototypeViewportKind);
        }
      }}
    >
      <Tabs.ListContainer>
        <Tabs.List aria-label="Prototype device">
          {prototypeViewportKinds.map((kind) => {
            const Icon = icons[kind];
            return (
              <Tabs.Tab key={kind} id={kind}>
                <span className="inline-flex items-center gap-2">
                  <Icon aria-hidden className="size-3.5 shrink-0" />
                  {prototypeViewportPresets[kind].label}
                </span>
              </Tabs.Tab>
            );
          })}
        </Tabs.List>
      </Tabs.ListContainer>
    </Tabs>
  );
}

function DesktopTarget({
  scenario,
  theme
}: {
  scenario: PrototypeScenarioKind;
  theme: PrototypeTheme;
}) {
  const fixture = useMemo(() => desktopPrototypeScenario(scenario), [scenario]);
  return (
    <div
      className={`prototype-target min-h-full px-5 py-7 @md:px-8 @md:py-9 ${
        theme === 'light' ? 'prototype-target--light' : 'prototype-target--dark'
      }`}
    >
      <header className="mx-auto mb-8 flex w-full max-w-5xl items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="truncate text-base font-semibold text-neutral-100">project-space</p>
          <p className="mt-1 text-xs text-neutral-500">DotNaos</p>
        </div>
        <span className="inline-flex items-center gap-2 text-xs text-neutral-500">
          <Laptop className="size-3.5" />
          Prototype
        </span>
      </header>
      <ProjectRootSummary
        connector={fixture.connector}
        dataSource={fixture.dataSource}
        projects={fixture.projects}
        recentProjectIds={fixture.recentProjectIds}
      />
    </div>
  );
}

function EmbeddedDesktopPrototype() {
  const initial = prototypeSelectionFromSearch(window.location.search, 'desktop');
  const presentation = prototypePresentationFromSearch(window.location.search);
  return (
    <main
      data-theme={presentation.theme}
      className={`prototype-embedded size-full min-h-0 overflow-auto ${
        initial.viewport === 'phone' && presentation.orientation === 'portrait'
          ? 'pt-6'
          : initial.viewport === 'phone'
            ? 'pr-6'
            : ''
      }`}
    >
      <DesktopTarget scenario={initial.scenario} theme={presentation.theme} />
    </main>
  );
}

function PrototypeWorkspace() {
  const initial = prototypeSelectionFromSearch(window.location.search, 'desktop');
  const initialPresentation = prototypePresentationFromSearch(
    window.location.search
  );
  const [scenario] = useState<PrototypeScenarioKind>(initial.scenario);
  const [viewport, setViewport] = useState<PrototypeViewportKind>(initial.viewport);
  const [presentation, setPresentation] = useState(initialPresentation);
  const [hudVisible, setHudVisible] = useState(!initialPresentation.fullscreen);
  const [isRotating, setIsRotating] = useState(false);
  const [isSwitchingViewport, setIsSwitchingViewport] = useState(false);
  const hideHudTimer = useRef<number | undefined>(undefined);
  const rotationTimer = useRef<number | undefined>(undefined);
  const viewportSwitchTimer = useRef<number | undefined>(undefined);
  const preset = prototypeViewportPresets[viewport];

  const cancelHudHide = () => {
    if (hideHudTimer.current === undefined) return;
    window.clearTimeout(hideHudTimer.current);
    hideHudTimer.current = undefined;
  };
  const scheduleHudHide = () => {
    cancelHudHide();
    hideHudTimer.current = window.setTimeout(() => {
      setHudVisible(false);
      hideHudTimer.current = undefined;
    }, 2800);
  };
  const revealHud = () => {
    setHudVisible(true);
    scheduleHudHide();
  };
  const updatePresentation = (next: PrototypePresentation) => {
    setPresentation(next);
    replaceSelection(viewport, scenario, next);
    if (next.fullscreen) {
      setHudVisible(false);
    } else {
      cancelHudHide();
      setHudVisible(true);
    }
  };

  const chooseViewport = (next: PrototypeViewportKind) => {
    if (next === viewport || isRotating || isSwitchingViewport) return;
    setIsSwitchingViewport(true);
    viewportSwitchTimer.current = window.setTimeout(() => {
      setViewport(next);
      replaceSelection(next, scenario, presentation);
      viewportSwitchTimer.current = window.setTimeout(() => {
        setIsSwitchingViewport(false);
        viewportSwitchTimer.current = undefined;
      }, VIEWPORT_SWAP_MS);
    }, VIEWPORT_HIDE_MS);
  };
  const chooseSurface = (next: 'web' | 'expo') => {
    if (next === 'web') return;
    window.location.assign(
      prototypeSurfaceHref(
        'expo',
        viewport,
        mobileScenarioFor(scenario),
        presentation
      )
    );
  };
  const rotateDevice = () => {
    if (viewport === 'desktop' || isRotating || isSwitchingViewport) return;
    setIsRotating(true);
    rotationTimer.current = window.setTimeout(() => {
      updatePresentation({
        ...presentation,
        orientation:
          presentation.orientation === 'portrait' ? 'landscape' : 'portrait'
      });
      rotationTimer.current = window.setTimeout(() => {
        setIsRotating(false);
        rotationTimer.current = undefined;
      }, ROTATION_DURATION_MS);
    }, ROTATION_CONTENT_HIDE_MS);
  };

  useEffect(() => {
    const exitFullscreen = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !presentation.fullscreen) return;
      updatePresentation({ ...presentation, fullscreen: false });
    };
    window.addEventListener('keydown', exitFullscreen);
    return () => window.removeEventListener('keydown', exitFullscreen);
  });

  useEffect(() => {
    return () => {
      cancelHudHide();
      if (rotationTimer.current !== undefined) {
        window.clearTimeout(rotationTimer.current);
      }
      if (viewportSwitchTimer.current !== undefined) {
        window.clearTimeout(viewportSwitchTimer.current);
      }
    };
  }, []);

  return (
    <main className="prototype-app" data-theme={presentation.theme}>
      <section
        className="prototype-stage"
        data-fullscreen={presentation.fullscreen}
      >
        {presentation.fullscreen ? (
          <button
            aria-label="Show prototype controls"
            className="prototype-hud-edge"
            onFocus={revealHud}
            onMouseEnter={revealHud}
            onPointerDown={revealHud}
            type="button"
          />
        ) : null}
        <div
          className="prototype-hud-shell"
          data-visible={!presentation.fullscreen || hudVisible}
          data-testid="viewport-controls"
          onMouseEnter={cancelHudHide}
          onMouseLeave={presentation.fullscreen ? scheduleHudHide : undefined}
        >
          <div className="prototype-hud__surface">
            <SurfaceTabs onChange={chooseSurface} />
          </div>
          <div className="prototype-hud__devices">
            <ViewportTabs viewport={viewport} onChange={chooseViewport} />
            <Button
              isIconOnly
              aria-label={
                presentation.showDeviceFrame
                  ? 'Hide device frame'
                  : 'Show device frame'
              }
              className="prototype-hud__frame"
              size="sm"
              variant="ghost"
              onPress={() => {
                updatePresentation({
                  ...presentation,
                  showDeviceFrame: !presentation.showDeviceFrame
                });
              }}
            >
              {presentation.showDeviceFrame ? (
                <EyeOff className="size-4" />
              ) : (
                <Eye className="size-4" />
              )}
            </Button>
          </div>
          <div className="prototype-hud__actions">
            <Button
              isIconOnly
              aria-label={
                presentation.theme === 'dark'
                  ? 'Use light mode'
                  : 'Use dark mode'
              }
              size="sm"
              variant="ghost"
              onPress={() => {
                updatePresentation({
                  ...presentation,
                  theme: presentation.theme === 'dark' ? 'light' : 'dark'
                });
              }}
            >
              {presentation.theme === 'dark' ? (
                <Sun className="size-4" />
              ) : (
                <Moon className="size-4" />
              )}
            </Button>
            <Button
              isDisabled={
                viewport === 'desktop' ||
                isRotating ||
                isSwitchingViewport
              }
              isIconOnly
              aria-label="Rotate device"
              size="sm"
              variant="ghost"
              onPress={rotateDevice}
            >
              <RotateCw className="size-4" />
            </Button>
            <Button
              isIconOnly
              aria-label={
                presentation.fullscreen
                  ? 'Exit fullscreen'
                  : 'Enter fullscreen'
              }
              size="sm"
              variant="ghost"
              onPress={() => {
                updatePresentation({
                  ...presentation,
                  fullscreen: !presentation.fullscreen
                });
              }}
            >
              {presentation.fullscreen ? (
                <Minimize2 className="size-4" />
              ) : (
                <Maximize2 className="size-4" />
              )}
            </Button>
          </div>
        </div>
        <ScaledDeviceCanvas
          fullscreen={presentation.fullscreen}
          isRotating={isRotating}
          isSwitchingViewport={isSwitchingViewport}
          orientation={presentation.orientation}
          showDeviceFrame={presentation.showDeviceFrame}
          viewport={preset}
        >
          <DesktopTarget scenario={scenario} theme={presentation.theme} />
        </ScaledDeviceCanvas>
      </section>
    </main>
  );
}

export function PrototypeApp() {
  const embedded = new URLSearchParams(window.location.search).get('embedded') === '1';
  return embedded ? <EmbeddedDesktopPrototype /> : <PrototypeWorkspace />;
}
