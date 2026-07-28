import { useEffect, useMemo, useRef, useState, type Key } from 'react';
import { Button, Tabs } from '@heroui/react';
import {
  AppWindow,
  Bot,
  Eye,
  EyeOff,
  FileClock,
  Globe2,
  Maximize2,
  Minimize2,
  Moon,
  Monitor,
  RotateCw,
  Smartphone,
  Sun,
  Tablet as TabletIcon,
  X
} from 'lucide-react';

import { projectSpaceClient } from '@/api/project-space-client';
import { Text } from '@/app/dotnaos-ui';
import { PullRequestChangelogSummary } from '@/features/pr-preview-changelog/pull-request-changelog-summary';
import { pullRequestChangelogSnapshotFor } from '@/features/pr-preview-changelog/pull-request-changelog-snapshot';
import type { PullRequestTestSurfacesResult } from '@/shared/pr-preview-test-surfaces-api';
import {
  type PullRequestChangelogIdentity
} from '@/shared/pr-preview-changelog-api';
import {
  prototypeViewportKinds,
  prototypeViewportPresets,
  type PrototypeTheme,
  type PrototypeViewportKind
} from '@/shared/prototype-canvas';
import { PrototypeReviewCodexPanel } from './prototype-review-codex-panel';
import { PrototypeReviewDevice } from './prototype-review-device';
import {
  developmentPrototypeTarget,
  embeddedPrototypeUrl,
  isIsolatedPrototypeTarget,
  parsePrototypeReviewRoute,
  verifiedPrototypeTarget,
  type PrototypeReviewSurface
} from './prototype-review-model';

type ReviewPanel = 'changelog' | 'codex';

const ROTATION_DURATION_MS = 360;
const ROTATION_CONTENT_HIDE_MS = 100;

const deviceIcons = {
  desktop: Monitor,
  phone: Smartphone,
  tablet: TabletIcon
};

function SurfaceTabs({
  onChange,
  surface
}: {
  onChange(value: PrototypeReviewSurface): void;
  surface: PrototypeReviewSurface;
}) {
  return (
    <Tabs
      aria-label="Prototype app"
      selectedKey={surface}
      variant="primary"
      onSelectionChange={(key: Key) => {
        if (key === 'web' || key === 'native') onChange(key);
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
          <Tabs.Tab id="native">
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
            const Icon = deviceIcons[kind];
            return (
              <Tabs.Tab id={kind} key={kind}>
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

function ChangelogSlot({
  pullRequestNumber,
  repositoryFullName,
  result
}: {
  pullRequestNumber?: number;
  repositoryFullName?: string;
  result?: PullRequestTestSurfacesResult;
}) {
  if (!pullRequestNumber || !repositoryFullName || !result) {
    return (
      <section className="grid h-full place-items-center bg-neutral-950 px-6 text-center">
        <div className="max-w-sm">
          <FileClock className="mx-auto size-6 text-neutral-700" />
          <Text as="h2" className="mt-4 block text-sm font-medium text-neutral-200">
            Changelog is unavailable
          </Text>
          <Text className="mt-2 block text-xs leading-5 text-neutral-500">
            A verified repository, pull request, and head revision are required.
          </Text>
        </div>
      </section>
    );
  }
  const identity: PullRequestChangelogIdentity = {
    headSha: result.headSha,
    pullRequestNumber,
    repositoryFullName
  };
  const snapshot = pullRequestChangelogSnapshotFor(identity);
  return (
    <section className="h-full overflow-y-auto bg-neutral-950 px-3 pb-4 pt-12">
      <PullRequestChangelogSummary
        className="border-t-0"
        expectedIdentity={identity}
        snapshot={snapshot}
      />
    </section>
  );
}

export function PrototypeReviewPage() {
  const initial = useMemo(
    () => parsePrototypeReviewRoute(window.location.pathname, window.location.search),
    []
  );
  const [surface, setSurface] = useState(initial.surface);
  const [viewport, setViewport] = useState(initial.viewport);
  const [orientation, setOrientation] = useState(initial.orientation);
  const [theme, setTheme] = useState<PrototypeTheme>(initial.theme);
  const [showDeviceFrame, setShowDeviceFrame] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [hudVisible, setHudVisible] = useState(true);
  const [isRotating, setIsRotating] = useState(false);
  const [panel, setPanel] = useState<ReviewPanel>();
  const [result, setResult] = useState<PullRequestTestSurfacesResult>();
  const [surfaceError, setSurfaceError] = useState<string>();
  const hideHudTimer = useRef<number | undefined>(undefined);
  const rotationTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!initial.repositoryFullName || !initial.pullRequestNumber) return;
    let active = true;
    let loading = false;
    const load = async () => {
      if (loading || document.hidden) return;
      loading = true;
      try {
        const next = await projectSpaceClient.getPullRequestTestSurfaces(
          initial.repositoryFullName!,
          initial.pullRequestNumber!
        );
        if (active) {
          setResult(next);
          setSurfaceError(undefined);
        }
      } catch (error) {
        if (active) {
          setSurfaceError(error instanceof Error ? error.message : 'Could not verify PR surfaces.');
        }
      } finally {
        loading = false;
      }
    };
    void load();
    const interval = window.setInterval(() => void load(), 10_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [initial.pullRequestNumber, initial.repositoryFullName]);

  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (panel) setPanel(undefined);
      else if (fullscreen) {
        setFullscreen(false);
        setHudVisible(true);
      }
    };
    window.addEventListener('keydown', onEscape);
    return () => window.removeEventListener('keydown', onEscape);
  }, [fullscreen, panel]);

  useEffect(() => () => {
    if (hideHudTimer.current !== undefined) window.clearTimeout(hideHudTimer.current);
    if (rotationTimer.current !== undefined) window.clearTimeout(rotationTimer.current);
  }, []);

  const verified = verifiedPrototypeTarget(result, surface);
  const development = import.meta.env.DEV
    ? developmentPrototypeTarget(initial.devTargetUrl, window.location.href, surface)
    : undefined;
  const candidateTarget = verified ?? development;
  const target = isIsolatedPrototypeTarget(candidateTarget, window.location.href)
    ? candidateTarget
    : undefined;
  const targetUrl = target
    ? embeddedPrototypeUrl(
        target,
        initial.scenario,
        viewport,
        orientation,
        theme
      )
    : undefined;

  function scheduleHudHide() {
    if (hideHudTimer.current !== undefined) window.clearTimeout(hideHudTimer.current);
    hideHudTimer.current = window.setTimeout(() => {
      setHudVisible(false);
      hideHudTimer.current = undefined;
    }, 2_800);
  }

  function revealHud() {
    setHudVisible(true);
    scheduleHudHide();
  }

  function rotateDevice() {
    if (viewport === 'desktop' || isRotating) return;
    setIsRotating(true);
    rotationTimer.current = window.setTimeout(() => {
      setOrientation((current) =>
        current === 'portrait' ? 'landscape' : 'portrait'
      );
      rotationTimer.current = window.setTimeout(() => {
        setIsRotating(false);
        rotationTimer.current = undefined;
      }, ROTATION_DURATION_MS);
    }, ROTATION_CONTENT_HIDE_MS);
  }

  return (
    <main
      data-theme={theme}
      className={`fixed inset-0 flex min-h-0 flex-col overflow-hidden ${
        theme === 'dark'
          ? 'bg-black text-neutral-100'
          : 'bg-white text-neutral-900'
      }`}
    >
      {fullscreen ? (
        <button
          aria-label="Show prototype controls"
          className="fixed inset-x-0 top-0 z-40 h-[18px] bg-transparent"
          onFocus={revealHud}
          onMouseEnter={revealHud}
          onPointerDown={revealHud}
          type="button"
        />
      ) : null}
      <div
        className={`z-50 h-[60px] w-full transition-[opacity,transform] duration-200 max-[900px]:h-28 ${
          fullscreen
            ? 'fixed inset-x-0 top-0'
            : 'relative shrink-0'
        } ${fullscreen && !hudVisible ? '-translate-y-4 opacity-0 pointer-events-none' : ''}`}
        onMouseEnter={() => {
          if (hideHudTimer.current !== undefined) window.clearTimeout(hideHudTimer.current);
        }}
        onMouseLeave={fullscreen ? scheduleHudHide : undefined}
      >
        <div className="absolute left-3 top-2">
          <SurfaceTabs onChange={setSurface} surface={surface} />
        </div>
        <div className="absolute left-1/2 top-2 flex -translate-x-1/2 items-center gap-1 max-[900px]:top-[60px]">
          <ViewportTabs onChange={setViewport} viewport={viewport} />
          <Button
            aria-label={showDeviceFrame ? 'Hide device frame' : 'Show device frame'}
            className={`rounded-2xl backdrop-blur-xl ${
              theme === 'dark'
                ? 'bg-neutral-900/95 shadow-[0_14px_42px_rgba(0,0,0,0.32)]'
                : 'bg-white/95 shadow-[0_14px_42px_rgba(39,39,42,0.10)]'
            }`}
            isIconOnly
            size="sm"
            variant="ghost"
            onPress={() => setShowDeviceFrame((current) => !current)}
          >
            {showDeviceFrame ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </Button>
        </div>
        <div
          className={`absolute right-3 top-2 flex items-center gap-0.5 rounded-2xl p-1 backdrop-blur-xl ${
            theme === 'dark'
              ? 'bg-neutral-900/95 shadow-[0_14px_42px_rgba(0,0,0,0.32)]'
              : 'bg-white/95 shadow-[0_14px_42px_rgba(39,39,42,0.10)]'
          }`}
        >
          <Button
            aria-label={theme === 'dark' ? 'Use light mode' : 'Use dark mode'}
            isIconOnly
            size="sm"
            variant="ghost"
            onPress={() => {
              setTheme((current) => current === 'dark' ? 'light' : 'dark');
            }}
          >
            {theme === 'dark' ? (
              <Sun className="size-4" />
            ) : (
              <Moon className="size-4" />
            )}
          </Button>
          <Button
            aria-label="Rotate device"
            isDisabled={viewport === 'desktop' || isRotating}
            isIconOnly
            size="sm"
            variant="ghost"
            onPress={rotateDevice}
          >
            <RotateCw className="size-4" />
          </Button>
          <Button
            aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            isIconOnly
            size="sm"
            variant="ghost"
            onPress={() => {
              const next = !fullscreen;
              setFullscreen(next);
              setPanel(undefined);
              setHudVisible(!next);
            }}
          >
            {fullscreen ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
          </Button>
        </div>
      </div>

      <div className="relative flex min-h-0 min-w-0 flex-1">
        <PrototypeReviewDevice
          fullscreen={fullscreen}
          isRotating={isRotating}
          orientation={orientation}
          showDeviceFrame={showDeviceFrame}
          theme={theme}
          viewportKind={viewport}
        >
          {targetUrl ? (
            <iframe
              className={`size-full border-0 ${
                theme === 'dark' ? 'bg-neutral-950' : 'bg-stone-50'
              }`}
              referrerPolicy="no-referrer"
              sandbox="allow-same-origin allow-scripts"
              src={targetUrl}
              title={`${surface === 'native' ? 'Native' : 'Web'} prototype`}
            />
          ) : (
            <div className="grid size-full place-items-center bg-neutral-950 px-8 text-center">
              <div className="max-w-sm">
                <Monitor className="mx-auto size-6 text-neutral-700" />
                <Text className="mt-4 block text-sm font-medium text-neutral-300">
                  No verified prototype is available
                </Text>
                <Text className="mt-2 block text-xs leading-5 text-neutral-500">
                  {surfaceError ??
                    'Open this workspace from a verified PR surface or a local development target.'}
                </Text>
              </div>
            </div>
          )}
        </PrototypeReviewDevice>

        {panel && !fullscreen ? (
          <aside className="absolute inset-y-3 right-3 z-30 w-[min(26rem,calc(100%-1.5rem))] overflow-hidden rounded-2xl bg-neutral-950/98 shadow-[0_24px_80px_rgba(0,0,0,0.6)] backdrop-blur-xl max-[720px]:inset-x-3 max-[720px]:bottom-3 max-[720px]:top-auto max-[720px]:h-[min(68vh,38rem)] max-[720px]:w-auto">
            <Button
              aria-label="Close review panel"
              className="absolute right-2 top-2 z-20"
              isIconOnly
              size="sm"
              variant="ghost"
              onPress={() => setPanel(undefined)}
            >
              <X className="size-4" />
            </Button>
            {panel === 'changelog' ? (
              <ChangelogSlot
                pullRequestNumber={initial.pullRequestNumber}
                repositoryFullName={initial.repositoryFullName}
                result={result}
              />
            ) : initial.repositoryFullName && initial.pullRequestNumber ? (
              <PrototypeReviewCodexPanel
                pullRequestNumber={initial.pullRequestNumber}
                repositoryFullName={initial.repositoryFullName}
                result={result}
                scenario={initial.scenario}
                target={target}
                viewport={viewport}
              />
            ) : (
              <section className="grid h-full place-items-center px-6 text-center">
                <div className="max-w-sm">
                  <Bot className="mx-auto size-6 text-neutral-700" />
                  <Text className="mt-4 block text-sm text-neutral-300">PR context is missing</Text>
                  <Text className="mt-2 block text-xs leading-5 text-neutral-500">
                    Open this workspace from a pull request before connecting its Codex task.
                  </Text>
                </div>
              </section>
            )}
          </aside>
        ) : null}
      </div>

      {!fullscreen ? (
        <nav aria-label="Prototype review tools" className="z-20 flex shrink-0 justify-center px-3 pb-3 pt-1">
          <div className="flex items-center gap-1 rounded-2xl bg-neutral-900/95 p-1 shadow-[0_14px_42px_rgba(0,0,0,0.32)] backdrop-blur-xl">
            <Button
              size="sm"
              variant={panel === 'changelog' ? 'primary' : 'ghost'}
              onPress={() => setPanel((current) => current === 'changelog' ? undefined : 'changelog')}
            >
              <FileClock className="size-3.5" />
              Changelog
            </Button>
            <Button
              size="sm"
              variant={panel === 'codex' ? 'primary' : 'ghost'}
              onPress={() => setPanel((current) => current === 'codex' ? undefined : 'codex')}
            >
              <Bot className="size-3.5" />
              Codex
            </Button>
          </div>
        </nav>
      ) : null}
    </main>
  );
}
