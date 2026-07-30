import { useEffect, useMemo, useRef, useState, type Key } from 'react';
import { Button, Tabs } from '@heroui/react';
import {
  AppWindow,
  Eye,
  EyeOff,
  Globe2,
  Maximize2,
  Minimize2,
  Moon,
  Monitor,
  RotateCw,
  ScrollText,
  Smartphone,
  Sun,
  Tablet as TabletIcon
} from 'lucide-react';

import { projectSpaceClient } from '@/api/project-space-client';
import { Text } from '@/app/dotnaos-ui';
import { pullRequestChangelogSnapshotFor } from '@/features/pr-preview-changelog/pull-request-changelog-snapshot';
import {
  isPullRequestChangelogIdentity,
  type PullRequestChangelogIdentity
} from '@/shared/pr-preview-changelog-api';
import {
  pullRequestChangelogPrototypeSelection,
  pullRequestPrototypeIdentityMatches
} from '@/shared/pr-preview-changelog-prototypes';
import type { PullRequestTestSurfacesResult } from '@/shared/pr-preview-test-surfaces-api';
import {
  prototypeViewportKinds,
  prototypeViewportPresets,
  type PrototypeTheme,
  type PrototypeViewportKind
} from '@/shared/prototype-canvas';
import { PrototypeReviewChangelogModal } from './prototype-review-changelog-modal';
import { PrototypeReviewCodexDock } from './prototype-review-codex-dock';
import { PrototypeReviewCodexStatus } from './prototype-review-codex-status';
import { PrototypeReviewDevice } from './prototype-review-device';
import { usePrototypeReviewAnnotations } from './prototype-review-annotations';
import {
  usePrototypeReviewLocalContext,
  type PrototypeReviewLocalContextResult
} from './use-prototype-review-local-context';
import {
  developmentPrototypeTarget,
  embeddedPrototypeUrl,
  isIsolatedPrototypeTarget,
  parsePrototypeReviewRoute,
  prototypeReviewCodexContext,
  verifiedPrototypeTarget,
  type PrototypeReviewSurface
} from './prototype-review-model';

type ReviewPanel = 'changelog';

const ROTATION_DURATION_MS = 360;
const ROTATION_CONTENT_HIDE_MS = 100;
const FRAME_REVEAL_DELAY_MS = 220;

const deviceIcons = {
  desktop: Monitor,
  phone: Smartphone,
  tablet: TabletIcon
};

function localCodexStatusMessage(result: PrototypeReviewLocalContextResult) {
  if (result.state === 'loading') return 'Connecting to the local Codex task…';
  if (result.state !== 'available') {
    return 'The local Codex connection could not be verified.';
  }
  if (result.context.checkout.state === 'unavailable') {
    return 'The local checkout could not be verified.';
  }
  if (result.context.codex.state === 'available') {
    return 'Connecting to the local Codex task…';
  }
  const messages = {
    'checkout-unavailable': 'The local checkout could not be verified.',
    'codex-unavailable': 'Codex is unavailable through the owning connector.',
    'missing-thread': 'No owning Codex task is attached to this dev server.',
    'repository-mismatch': 'This checkout does not match the requested repository.',
    'task-mismatch': 'This dev server belongs to a different Codex task.'
  } as const;
  return messages[result.context.codex.reason];
}

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
              <span className="max-[340px]:sr-only">Web</span>
            </span>
          </Tabs.Tab>
          <Tabs.Tab id="native">
            <span className="inline-flex items-center gap-2">
              <AppWindow aria-hidden className="size-3.5 shrink-0" />
              <span className="max-[340px]:sr-only">Native</span>
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
        if (
          typeof key === 'string' &&
          prototypeViewportKinds.includes(key as PrototypeViewportKind)
        ) {
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
                  <span className="max-[640px]:sr-only">
                    {prototypeViewportPresets[kind].label}
                  </span>
                </span>
              </Tabs.Tab>
            );
          })}
        </Tabs.List>
      </Tabs.ListContainer>
    </Tabs>
  );
}

export function PrototypeReviewPage() {
  const initial = useMemo(
    () => parsePrototypeReviewRoute(window.location.pathname, window.location.search),
    []
  );
  const requestedIdentity = useMemo(
    (): PullRequestChangelogIdentity | undefined => {
      const identity = {
        headSha: initial.headSha ?? '',
        pullRequestNumber: initial.pullRequestNumber ?? 0,
        repositoryFullName: initial.repositoryFullName ?? ''
      };
      return isPullRequestChangelogIdentity(identity)
        ? identity
        : undefined;
    },
    [initial.headSha, initial.pullRequestNumber, initial.repositoryFullName]
  );
  const initialSelection = useMemo(
    () =>
      requestedIdentity
        ? pullRequestChangelogPrototypeSelection(
            pullRequestChangelogSnapshotFor(requestedIdentity),
            requestedIdentity,
            initial.changeId
          )
        : {
            message:
              'A verified repository, pull request, and full head revision are required.',
            state: 'unavailable' as const
          },
    [initial.changeId, requestedIdentity]
  );
  const selectedSurface =
    initialSelection.state === 'ready'
      ? initialSelection.entry.prototype!.surface ===
        'mobile-prototype'
        ? 'native'
        : 'web'
      : initial.surface;
  const [surface, setSurface] = useState(selectedSurface);
  const [viewport, setViewport] = useState(initial.viewport);
  const [orientation, setOrientation] = useState(initial.orientation);
  const [theme, setTheme] = useState<PrototypeTheme>(initial.theme);
  const [showDeviceFrame, setShowDeviceFrame] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [hudVisible, setHudVisible] = useState(true);
  const [isRotating, setIsRotating] = useState(false);
  const [loadedTargetUrl, setLoadedTargetUrl] = useState<string>();
  const [panel, setPanel] = useState<ReviewPanel | undefined>(
    initialSelection.state === 'ready' ? undefined : 'changelog'
  );
  const [result, setResult] = useState<PullRequestTestSurfacesResult>();
  const [surfaceError, setSurfaceError] = useState<string>();
  const frameRevealTimer = useRef<number | undefined>(undefined);
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

  useEffect(
    () => () => {
      if (frameRevealTimer.current !== undefined) window.clearTimeout(frameRevealTimer.current);
      if (hideHudTimer.current !== undefined) window.clearTimeout(hideHudTimer.current);
      if (rotationTimer.current !== undefined) window.clearTimeout(rotationTimer.current);
    },
    []
  );

  const resultIdentity = result
    ? {
        headSha: result.headSha,
        pullRequestNumber: result.pullRequestNumber,
        repositoryFullName: result.repositoryFullName
      }
    : undefined;
  const exactResult = Boolean(
    requestedIdentity &&
      pullRequestPrototypeIdentityMatches(
        requestedIdentity,
        resultIdentity
      )
  );
  const verified = exactResult
    ? verifiedPrototypeTarget(result, surface)
    : undefined;
  const development = import.meta.env.DEV
    ? developmentPrototypeTarget(
        initial.devTargetUrl,
        window.location.href,
        surface
      )
    : undefined;
  const candidateTarget =
    initialSelection.state === 'ready'
      ? development ?? verified
      : undefined;
  const target = isIsolatedPrototypeTarget(candidateTarget, window.location.href)
    ? candidateTarget
    : undefined;
  const targetUrl = target
    ? embeddedPrototypeUrl(
        target,
        initialSelection.state === 'ready'
          ? initialSelection.entry.prototype!.scenarioId
          : '',
        viewport,
        orientation,
        theme
      )
    : undefined;
  const localContextResult = usePrototypeReviewLocalContext({
    enabled: import.meta.env.DEV && target?.source === 'development-override',
    pullRequestNumber: initial.pullRequestNumber,
    repositoryFullName: initial.repositoryFullName
  });
  const localContext = localContextResult.context;
  const developmentContext = prototypeReviewCodexContext(
    import.meta.env.DEV,
    result,
    target,
    localContext
  );
  const localCodexStatus = target?.source === 'development-override' && !developmentContext
    ? localCodexStatusMessage(localContextResult)
    : undefined;
  const targetOrigin = target ? new URL(target.url).origin : undefined;
  const { annotations, clearAnnotations, iframeRef, onFrameLoad, toggleAnnotations } =
    usePrototypeReviewAnnotations({
      enabled: Boolean(developmentContext),
      targetKey: targetUrl,
      targetOrigin
    });

  useEffect(() => {
    setLoadedTargetUrl(undefined);
    if (frameRevealTimer.current !== undefined) {
      window.clearTimeout(frameRevealTimer.current);
      frameRevealTimer.current = undefined;
    }
  }, [targetUrl]);

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
      setOrientation((current) => (current === 'portrait' ? 'landscape' : 'portrait'));
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
        theme === 'dark' ? 'bg-black text-neutral-100' : 'bg-white text-neutral-900'
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
        className={`z-50 grid h-[60px] w-full grid-cols-[1fr_auto_1fr] items-start px-3 pt-2 transition-[opacity,transform] duration-200 max-[900px]:h-28 max-[900px]:grid-cols-[1fr_auto] max-[900px]:grid-rows-[44px_44px] max-[900px]:gap-y-2 max-[640px]:px-2 ${
          fullscreen ? 'fixed inset-x-0 top-0' : 'relative shrink-0'
        } ${fullscreen && !hudVisible ? '-translate-y-4 opacity-0 pointer-events-none' : ''}`}
        onMouseEnter={() => {
          if (hideHudTimer.current !== undefined) window.clearTimeout(hideHudTimer.current);
        }}
        onMouseLeave={fullscreen ? scheduleHudHide : undefined}
      >
        <div className="min-w-0 justify-self-start">
          <SurfaceTabs onChange={setSurface} surface={surface} />
        </div>
        <div className="col-start-2 flex min-w-0 items-center gap-1 justify-self-center max-[900px]:col-span-2 max-[900px]:col-start-1 max-[900px]:row-start-2 max-[900px]:justify-self-start">
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
          <Button
            aria-label="Rotate device"
            className={`rounded-2xl backdrop-blur-xl ${
              theme === 'dark'
                ? 'bg-neutral-900/95 shadow-[0_14px_42px_rgba(0,0,0,0.32)]'
                : 'bg-white/95 shadow-[0_14px_42px_rgba(39,39,42,0.10)]'
            }`}
            isDisabled={viewport === 'desktop' || isRotating}
            isIconOnly
            size="sm"
            variant="ghost"
            onPress={rotateDevice}
          >
            <RotateCw className="size-4" />
          </Button>
        </div>
        <div
          className={`col-start-3 flex items-center gap-0.5 justify-self-end rounded-2xl p-1 backdrop-blur-xl max-[900px]:col-start-2 max-[900px]:row-start-1 ${
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
              setTheme((current) => (current === 'dark' ? 'light' : 'dark'));
            }}
          >
            {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
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
              className={`size-full border-0 bg-neutral-950 transition-opacity duration-150 ${
                loadedTargetUrl === targetUrl ? 'opacity-100' : 'opacity-0'
              }`}
              referrerPolicy="origin"
              ref={iframeRef}
              sandbox="allow-same-origin allow-scripts"
              src={targetUrl}
              title={`${surface === 'native' ? 'Native' : 'Web'} prototype`}
              onLoad={() => {
                onFrameLoad();
                if (frameRevealTimer.current !== undefined) {
                  window.clearTimeout(frameRevealTimer.current);
                }
                frameRevealTimer.current = window.setTimeout(() => {
                  if (iframeRef.current?.src === targetUrl) {
                    setLoadedTargetUrl(targetUrl);
                  }
                  frameRevealTimer.current = undefined;
                }, FRAME_REVEAL_DELAY_MS);
              }}
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
                    (initialSelection.state !== 'ready'
                      ? initialSelection.message
                      : !exactResult && !development
                        ? 'The available prototype does not match the requested repository, PR, and head commit.'
                        : 'Open this workspace from a verified PR surface or a local development target.')}
                </Text>
              </div>
            </div>
          )}
        </PrototypeReviewDevice>
      </div>

      {!fullscreen ? (
        <footer className="z-30 grid shrink-0 grid-cols-[max-content_minmax(0,1fr)_max-content] items-end gap-3 px-3 pb-3 pt-1 max-[1400px]:grid-cols-[max-content_minmax(0,1fr)] max-[640px]:grid-cols-1 max-[640px]:gap-2 max-[640px]:px-2">
          <Button
            aria-label="Open pull request changelog"
            className={`h-12 min-w-12 justify-self-start rounded-full px-4 backdrop-blur-xl max-[640px]:size-11 max-[640px]:min-w-11 max-[640px]:px-0 ${
              theme === 'dark'
                ? 'bg-neutral-900/95 shadow-[0_14px_42px_rgba(0,0,0,0.32)]'
                : 'bg-stone-100/95 shadow-[0_14px_42px_rgba(39,39,42,0.14)]'
            }`}
            variant="ghost"
            onPress={() => setPanel('changelog')}
          >
            <ScrollText className="size-[1.125rem]" />
            <span className="max-[640px]:hidden">Changelog</span>
          </Button>

          <div className="min-w-0 max-[640px]:w-full">
            {developmentContext && initial.repositoryFullName && initial.pullRequestNumber ? (
              <PrototypeReviewCodexDock
                annotations={annotations}
                key={
                  developmentContext
                    ? `${developmentContext.machineId}:${developmentContext.threadId}:${target?.surfaceKind}`
                    : 'inactive'
                }
                development={developmentContext}
                onAnnotationsSent={clearAnnotations}
                onToggleAnnotations={toggleAnnotations}
                theme={theme}
              />
            ) : localCodexStatus ? (
              <PrototypeReviewCodexStatus
                isConnecting={localContextResult.state === 'loading'}
                message={localCodexStatus}
                theme={theme}
                onRetry={localContextResult.retry}
              />
            ) : null}
          </div>

          <div
            aria-hidden
            className="invisible flex h-12 items-center gap-2 px-4 max-[1400px]:hidden"
          >
            <ScrollText className="size-[1.125rem]" />
            <span className="max-[640px]:hidden">Changelog</span>
          </div>
        </footer>
      ) : null}

      <PrototypeReviewChangelogModal
        isOpen={!fullscreen && panel === 'changelog'}
        pullRequestNumber={initial.pullRequestNumber}
        repositoryFullName={initial.repositoryFullName}
        expectedIdentity={requestedIdentity}
        localContext={localContext}
        prototypeTarget={initial.devTargetUrl}
        result={result}
        selectedChangeId={initial.changeId}
        theme={theme}
        onOpenChange={(open) => setPanel(open ? 'changelog' : undefined)}
      />
    </main>
  );
}
