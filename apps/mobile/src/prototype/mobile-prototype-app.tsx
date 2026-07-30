import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Platform,
  Pressable,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Uniwind } from 'uniwind';

import { ProjectOverviewScreen } from '../features/overview/components/project-overview-screen';
import {
  DEFAULT_PROJECT_OVERVIEW_SCENARIO_ID,
  PROJECT_OVERVIEW_PROTOTYPE_SCENARIOS,
  projectOverviewPrototypeScenario,
} from './project-overview-scenarios';
import {
  PrototypeFrameControl,
  PrototypePresentationControls,
  PrototypeSurfaceTabs,
  PrototypeViewportTabs,
} from './prototype-controls';
import { PrototypeDeviceCanvas } from './prototype-device-frame';
import { NativeReviewDock } from '../review/native-review-dock';
import { nativeReviewConfig } from '../review/native-review-api';
import {
  mobilePrototypeSearch,
  prototypePresentationSearch,
  readPrototypePresentation,
  readMobilePrototypeLocation,
  type PrototypePresentation,
  type PrototypeViewport,
  webPrototypePath,
} from './prototype-state';

const ROTATION_DURATION_MS = 360;
const ROTATION_CONTENT_HIDE_MS = 100;
const VIEWPORT_HIDE_MS = 120;
const VIEWPORT_SWAP_MS = 16;

function currentLocation() {
  if (Platform.OS !== 'web' || typeof window === 'undefined') {
    return { search: '' };
  }
  return window.location;
}

function replacePrototypeLocation(
  scenarioId: string,
  viewport: PrototypeViewport
) {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return;

  const search = mobilePrototypeSearch(window.location.search, {
    scenarioId,
    viewport,
  });
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${search}${window.location.hash}`
  );
}

function openWebPrototype(
  scenarioId: string,
  viewport: PrototypeViewport
) {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return;
  window.location.assign(
    webPrototypePath(scenarioId, viewport, window.location.search)
  );
}

function replacePrototypePresentation(presentation: PrototypePresentation) {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return;

  const search = prototypePresentationSearch(
    window.location.search,
    presentation
  );
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${search}${window.location.hash}`
  );
}

function EmbeddedMobilePrototype() {
  const scenarioIds = useMemo(
    () => PROJECT_OVERVIEW_PROTOTYPE_SCENARIOS.map((scenario) => scenario.id),
    []
  );
  const initial = useMemo(
    () =>
      readMobilePrototypeLocation(
        currentLocation().search,
        scenarioIds,
        DEFAULT_PROJECT_OVERVIEW_SCENARIO_ID
      ),
    [scenarioIds]
  );
  const scenario = projectOverviewPrototypeScenario(initial.scenarioId);
  const presentation = useMemo(
    () =>
      readPrototypePresentation(
        currentLocation().search,
        scenario?.theme ?? 'dark'
      ),
    [scenario?.theme]
  );

  useEffect(() => {
    Uniwind.setTheme(presentation.theme);
  }, [presentation.theme]);

  return (
    <View
      className="min-h-0 flex-1 bg-background"
      style={{
        paddingRight:
          initial.viewport === 'phone' &&
          presentation.orientation === 'landscape'
            ? 24
            : 0,
        paddingTop:
          initial.viewport === 'phone' &&
          presentation.orientation === 'portrait'
            ? 24
            : 0,
      }}
    >
      {scenario ? (
        <ProjectOverviewScreen
          accountLabel={scenario.accountLabel}
          errorMessage={scenario.errorMessage}
          inventory={scenario.inventory}
          isRefreshing={scenario.isRefreshing}
          onRefresh={() => undefined}
          sourceLabel={scenario.sourceLabel}
        />
      ) : (
        <PrototypeSelectionUnavailable
          reason={initial.scenarioState}
        />
      )}
    </View>
  );
}

function MobilePrototypeWorkspace() {
  const { width } = useWindowDimensions();
  const safeArea = useSafeAreaInsets();
  const controlsTopInset = Platform.OS === 'web' ? 0 : safeArea.top;
  const reviewConfig = useMemo(
    () => (Platform.OS === 'web' ? undefined : nativeReviewConfig()),
    []
  );
  const scenarioIds = useMemo(
    () => PROJECT_OVERVIEW_PROTOTYPE_SCENARIOS.map((scenario) => scenario.id),
    []
  );
  const initial = useMemo(
    () =>
      readMobilePrototypeLocation(
        currentLocation().search,
        scenarioIds,
        DEFAULT_PROJECT_OVERVIEW_SCENARIO_ID
      ),
    [scenarioIds]
  );
  const initialScenario = projectOverviewPrototypeScenario(initial.scenarioId);
  const initialPresentation = useMemo(
    () =>
      readPrototypePresentation(
        currentLocation().search,
        initialScenario?.theme ?? 'dark'
      ),
    [initialScenario?.theme]
  );
  const [scenarioId] = useState(initial.scenarioId);
  const [viewport, setViewport] = useState<PrototypeViewport>(initial.viewport);
  const [presentation, setPresentation] = useState(initialPresentation);
  const [hudVisible, setHudVisible] = useState(!initialPresentation.fullscreen);
  const [isRotating, setIsRotating] = useState(false);
  const [isSwitchingViewport, setIsSwitchingViewport] = useState(false);
  const hideHudTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );
  const rotationTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );
  const viewportSwitchTimer = useRef<
    ReturnType<typeof setTimeout> | undefined
  >(undefined);
  const scenario = projectOverviewPrototypeScenario(scenarioId);
  const compactControls = width < 900;
  const phoneControls = width < 520;
  const controlsVisible = !presentation.fullscreen || hudVisible;

  const cancelHudHide = () => {
    if (hideHudTimer.current === undefined) return;
    clearTimeout(hideHudTimer.current);
    hideHudTimer.current = undefined;
  };
  const scheduleHudHide = () => {
    cancelHudHide();
    hideHudTimer.current = setTimeout(() => {
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
    replacePrototypePresentation(next);
    if (next.fullscreen) {
      setHudVisible(false);
    } else {
      cancelHudHide();
      setHudVisible(true);
    }
  };
  const rotateDevice = () => {
    if (viewport === 'desktop' || isRotating || isSwitchingViewport) return;
    setIsRotating(true);
    rotationTimer.current = setTimeout(() => {
      updatePresentation({
        ...presentation,
        orientation:
          presentation.orientation === 'portrait' ? 'landscape' : 'portrait',
      });
      rotationTimer.current = setTimeout(() => {
        setIsRotating(false);
        rotationTimer.current = undefined;
      }, ROTATION_DURATION_MS);
    }, ROTATION_CONTENT_HIDE_MS);
  };
  const chooseViewport = (next: PrototypeViewport) => {
    if (next === viewport || isRotating || isSwitchingViewport) return;
    setIsSwitchingViewport(true);
    viewportSwitchTimer.current = setTimeout(() => {
      setViewport(next);
      viewportSwitchTimer.current = setTimeout(() => {
        setIsSwitchingViewport(false);
        viewportSwitchTimer.current = undefined;
      }, VIEWPORT_SWAP_MS);
    }, VIEWPORT_HIDE_MS);
  };

  useEffect(() => {
    Uniwind.setTheme(presentation.theme);
  }, [presentation.theme]);

  useEffect(() => {
    if (scenarioId) replacePrototypeLocation(scenarioId, viewport);
  }, [scenarioId, viewport]);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
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
        clearTimeout(rotationTimer.current);
      }
      if (viewportSwitchTimer.current !== undefined) {
        clearTimeout(viewportSwitchTimer.current);
      }
    };
  }, []);

  return (
    <View
      className={`min-h-0 flex-1 ${
        presentation.theme === 'dark' ? 'bg-black' : 'bg-white'
      }`}
    >
      {presentation.fullscreen ? (
        <Pressable
          accessibilityLabel="Show prototype controls"
          className="absolute inset-x-0 top-0 z-30 h-[18px]"
          onHoverIn={revealHud}
          onPress={revealHud}
        />
      ) : null}
      <View
        className={`relative w-full ${
          presentation.fullscreen
            ? 'absolute inset-x-0 top-0 z-40'
            : presentation.theme === 'dark'
              ? 'shrink-0 bg-black'
              : 'shrink-0 bg-white'
        }`}
        onPointerEnter={cancelHudHide}
        onPointerLeave={
          presentation.fullscreen ? scheduleHudHide : undefined
        }
        style={{
          height: (compactControls ? 112 : 60) + controlsTopInset,
          opacity: controlsVisible ? 1 : 0,
          pointerEvents: controlsVisible ? 'auto' : 'none',
          transform: [{ translateY: controlsVisible ? 0 : -16 }],
          transitionDuration: '220ms',
          transitionProperty: 'opacity, transform',
        } as never}
      >
        <View
          className="absolute left-3"
          style={{ top: controlsTopInset + 8 }}
        >
          <PrototypeSurfaceTabs
            onChange={(surface) => {
              if (surface === 'web' && scenarioId) {
                openWebPrototype(scenarioId, viewport);
              }
            }}
            surface="expo"
            theme={presentation.theme}
          />
        </View>
        <View
          className={`absolute flex-row items-center gap-1 ${
            phoneControls ? 'left-3' : 'left-1/2 -translate-x-1/2'
          }`}
          style={{ top: controlsTopInset + (compactControls ? 60 : 8) }}
        >
          <PrototypeViewportTabs
            iconOnly={phoneControls}
            onChange={chooseViewport}
            theme={presentation.theme}
            viewport={viewport}
          />
          <PrototypeFrameControl
            onFrameToggle={() => {
              updatePresentation({
                ...presentation,
                showDeviceFrame: !presentation.showDeviceFrame,
              });
            }}
            showDeviceFrame={presentation.showDeviceFrame}
            theme={presentation.theme}
          />
        </View>
        <PrototypePresentationControls
          fullscreen={presentation.fullscreen}
          onFullscreenToggle={() => {
            updatePresentation({
              ...presentation,
              fullscreen: !presentation.fullscreen,
            });
          }}
          onRotate={rotateDevice}
          onThemeToggle={() => {
            updatePresentation({
              ...presentation,
              theme: presentation.theme === 'dark' ? 'light' : 'dark',
            });
          }}
          rotateDisabled={
            viewport === 'desktop' || isRotating || isSwitchingViewport
          }
          topInset={controlsTopInset}
          theme={presentation.theme}
        />
      </View>
      <PrototypeDeviceCanvas
        bottomInset={reviewConfig && !presentation.fullscreen ? 116 : 0}
        fitToCanvas={Boolean(reviewConfig)}
        fullscreen={presentation.fullscreen}
        isRotating={isRotating}
        isSwitchingViewport={isSwitchingViewport}
        orientation={presentation.orientation}
        showDeviceFrame={presentation.showDeviceFrame}
        theme={presentation.theme}
        viewport={viewport}
      >
        {scenario ? (
          <ProjectOverviewScreen
            key={scenario.id}
            accountLabel={scenario.accountLabel}
            errorMessage={scenario.errorMessage}
            inventory={scenario.inventory}
            isRefreshing={scenario.isRefreshing}
            onRefresh={() => undefined}
            sourceLabel={scenario.sourceLabel}
          />
        ) : (
          <PrototypeSelectionUnavailable
            reason={initial.scenarioState}
          />
        )}
      </PrototypeDeviceCanvas>
      {reviewConfig && !presentation.fullscreen ? (
        <NativeReviewDock
          config={reviewConfig}
          orientation={presentation.orientation}
          theme={presentation.theme}
          viewport={viewport}
        />
      ) : null}
    </View>
  );
}

function PrototypeSelectionUnavailable({
  reason,
}: {
  reason: 'missing' | 'ready' | 'unknown';
}) {
  return (
    <View
      accessibilityRole="alert"
      className="min-h-72 flex-1 items-center justify-center bg-background px-8"
    >
      <Text className="text-center text-sm font-semibold text-foreground">
        Prototype Change unavailable
      </Text>
      <Text className="mt-2 max-w-sm text-center text-xs leading-5 text-muted">
        {reason === 'unknown'
          ? 'This prototype does not recognize the requested Change.'
          : 'Choose a Change from the pull request changelog.'}
      </Text>
    </View>
  );
}

export function MobilePrototypeApp() {
  const embedded =
    Platform.OS === 'web' &&
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('embedded') === '1';
  return embedded ? <EmbeddedMobilePrototype /> : <MobilePrototypeWorkspace />;
}
