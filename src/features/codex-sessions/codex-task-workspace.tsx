import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Monitor,
  PanelRightClose,
  PanelRightOpen,
  Square
} from 'lucide-react';
import {
  Button,
  Chip,
  Tab,
  TabIndicator,
  TabList,
  Tabs,
  Text
} from '@/app/dotnaos-ui';
import type {
  CodexSessionBrowserResult,
  CodexSessionBrowserRequest,
  CodexSessionTurnSettings
} from '@/shared/codex-sessions-api';
import {
  browserMirrorHasActivity,
  CodexBrowserPane,
  useCodexBrowserMirror
} from './codex-browser-pane';
import { CodexConversationPane } from './codex-conversation-pane';
import { CodexDecisionPanel } from './codex-decision-panel';
import { effectiveCodexSessionStatus } from './codex-sessions-model';
import { useCodexSessionModels } from './use-codex-session-models';
import { parseProjectCodexTaskTitle } from './project-codex-task-model';
import { CodexTaskStatusBar } from './codex-task-activity-summary';
import {
  clampCodexChatSplitPercent,
  shouldAutoOpenCodexBrowser
} from './codex-task-workspace-model';
import type {
  CodexApprovalDecision,
  CodexConversation,
  CodexMachine,
  CodexSession,
  CodexThreadOrigin,
  CodexUserInputDecision,
} from './codex-sessions-types';

function browserResult(state: ReturnType<typeof useCodexBrowserMirror>) {
  return state.kind === 'result'
    ? state.result
    : state.kind === 'reconnecting'
      ? state.previous
      : undefined;
}

function useResizableSplit(initial = 55) {
  const [chatPercent, setChatPercent] = useState(initial);
  const containerRef = useRef<HTMLDivElement>(null);

  function startResize() {
    const move = (event: PointerEvent) => {
      const bounds = containerRef.current?.getBoundingClientRect();
      if (!bounds?.width) return;
      const next = ((event.clientX - bounds.left) / bounds.width) * 100;
      setChatPercent(clampCodexChatSplitPercent(next));
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop, { once: true });
  }

  return { chatPercent, containerRef, startResize };
}

function useNarrowTaskLayout() {
  const [narrow, setNarrow] = useState(() => (
    typeof window === 'undefined' || !window.matchMedia('(min-width: 900px)').matches
  ));
  useEffect(() => {
    const query = window.matchMedia('(min-width: 900px)');
    const update = () => setNarrow(!query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return narrow;
}

export function CodexTaskWorkspace({
  activeTurnId,
  conversation,
  historyState,
  historyStatusDetail,
  loadBrowser,
  machine,
  onBack,
  onContinue,
  onInterrupt,
  onPermissionChange,
  onSteer,
  onResolveApproval,
  onResolveUserInput,
  session
}: {
  activeTurnId?: string;
  conversation?: CodexConversation;
  historyState: 'blocked' | 'loading' | 'ready';
  historyStatusDetail?: string;
  loadBrowser(request: CodexSessionBrowserRequest): Promise<CodexSessionBrowserResult>;
  machine?: CodexMachine;
  onBack?(): void;
  onContinue?(
    origin: CodexThreadOrigin,
    message: string,
    settings?: CodexSessionTurnSettings
  ): Promise<void> | void;
  onInterrupt?(origin: CodexThreadOrigin, turnId: string): Promise<void> | void;
  onPermissionChange?(origin: CodexThreadOrigin, permissionProfileId: string): Promise<void>;
  onSteer?(origin: CodexThreadOrigin, message: string): Promise<void> | void;
  onResolveApproval?(decision: CodexApprovalDecision): Promise<void> | void;
  onResolveUserInput?(decision: CodexUserInputDecision): Promise<void> | void;
  session: CodexSession;
}) {
  const origin = useMemo(() => ({
    machineId: session.machineId,
    threadId: session.threadId
  }), [session.machineId, session.threadId]);
  const [browserPollingPaused, setBrowserPollingPaused] = useState(false);
  const mirror = useCodexBrowserMirror({ enabled: !browserPollingPaused, load: loadBrowser, origin });
  const snapshot = browserResult(mirror);
  const browserTurnId = snapshot?.turnId;
  const [browserVisible, setBrowserVisible] = useState(false);
  const [narrowPane, setNarrowPane] = useState<'browser' | 'chat'>('chat');
  const [manualCollapsedTurn, setManualCollapsedTurn] = useState<string>();
  const autoOpenedTurns = useRef(new Set<string>());
  const { chatPercent, containerRef, startResize } = useResizableSplit();
  const narrowLayout = useNarrowTaskLayout();
  const hasBrowserActivity = browserMirrorHasActivity(mirror);
  const baseStatus = effectiveCodexSessionStatus(session, machine);
  const task = parseProjectCodexTaskTitle(session.title);
  const modelSelection = useCodexSessionModels(
    session,
    machine?.supportsModelSettings === true
  );

  useEffect(() => {
    setBrowserVisible(false);
    setBrowserPollingPaused(false);
    setNarrowPane('chat');
    setManualCollapsedTurn(undefined);
    autoOpenedTurns.current.clear();
  }, [session.machineId, session.threadId]);

  useEffect(() => {
    setBrowserPollingPaused(false);
  }, [activeTurnId]);

  useEffect(() => {
    if (!browserTurnId || !shouldAutoOpenCodexBrowser({
      activeTurnId,
      browserState: snapshot?.state,
      browserTurnId,
      manualCollapsedTurn,
      openedTurns: autoOpenedTurns.current
    })) return;
    autoOpenedTurns.current.add(browserTurnId);
    setBrowserVisible(true);
    setNarrowPane('browser');
  }, [activeTurnId, browserTurnId, manualCollapsedTurn, snapshot?.state]);

  function collapseBrowser() {
    setBrowserVisible(false);
    setBrowserPollingPaused(true);
    setNarrowPane('chat');
    setManualCollapsedTurn(activeTurnId ?? browserTurnId);
  }

  const decisions = (
    <CodexDecisionPanel
      conversation={conversation}
      onResolveApproval={onResolveApproval}
      onResolveUserInput={onResolveUserInput}
      session={session}
    />
  );
  const chat = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <CodexConversationPane
          activeTurnId={activeTurnId}
          conversation={conversation}
          historyState={historyState}
          historyStatusDetail={historyStatusDetail}
          machine={machine}
          modelSelection={modelSelection}
          onContinue={onContinue}
          onPermissionChange={onPermissionChange}
          onSteer={onSteer}
          session={session}
          showHeader={false}
          supplemental={decisions}
        />
      </div>
    </div>
  );
  const browser = <CodexBrowserPane state={mirror} taskTitle={task.title} />;

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col bg-neutral-950 text-neutral-100">
      <header className="flex min-h-[56px] shrink-0 items-center gap-3 px-3 pr-14 md:px-4">
        {onBack ? (
          <Button aria-label="Back to Codex tasks" className="size-8 min-h-0" isIconOnly onPress={onBack} size="sm" variant="ghost">
            <ArrowLeft className="size-4" />
          </Button>
        ) : null}
        <div className="min-w-0">
          <Text as="h1" className="block truncate text-sm font-semibold text-neutral-100">
            {task.title}
          </Text>
        </div>
        {hasBrowserActivity && !narrowLayout ? (
          <Chip className="items-center gap-1.5 text-emerald-300" size="sm">
            <Monitor className="size-3" /> Browser {snapshot?.state === 'live' ? 'live' : 'available'}
          </Chip>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          {baseStatus === 'active' && activeTurnId ? (
            <Button
              aria-label="Stop active Codex turn"
              className="size-8 min-h-0"
              isIconOnly
              onPress={() => void onInterrupt?.(origin, activeTurnId)}
              size="sm"
              variant="danger"
            >
              <Square className="size-3 fill-current" />
            </Button>
          ) : null}
          {hasBrowserActivity && !narrowLayout ? (
            <Button
              aria-label={browserVisible ? 'Collapse browser mirror' : 'Open browser mirror'}
              className="size-8 min-h-0"
              isIconOnly
              onPress={browserVisible ? collapseBrowser : () => {
                setBrowserPollingPaused(false);
                setBrowserVisible(true);
              }}
              size="sm"
              variant="ghost"
            >
              {browserVisible ? <PanelRightClose className="size-4" /> : <PanelRightOpen className="size-4" />}
            </Button>
          ) : null}
        </div>
      </header>
      <CodexTaskStatusBar machine={machine} session={session} />

      {!narrowLayout ? <div className="min-h-0 flex-1">
        {browserVisible && hasBrowserActivity ? (
          <div
            className="grid h-full min-h-0 min-w-0"
            ref={containerRef}
            style={{ gridTemplateColumns: `minmax(0,${chatPercent}fr) 6px minmax(0,${100 - chatPercent}fr)` }}
          >
            <div className="min-h-0 min-w-0">{chat}</div>
            <button
              aria-label="Resize chat and browser panes"
              className="group relative cursor-col-resize border-x border-neutral-800 bg-neutral-900 hover:bg-neutral-700"
              onPointerDown={startResize}
              type="button"
            >
              <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-neutral-600 opacity-0 group-hover:opacity-100" />
            </button>
            <div className="min-h-0 min-w-0">{browser}</div>
          </div>
        ) : chat}
      </div> : null}

      {narrowLayout ? <div className="flex min-h-0 flex-1 flex-col">
        {hasBrowserActivity ? (
          <Tabs
            className="shrink-0 border-b border-neutral-800/80 px-3"
            onSelectionChange={(key) => setNarrowPane(key as typeof narrowPane)}
            selectedKey={narrowPane}
          >
            <TabList aria-label="Codex task panes" className="flex h-10 items-center">
              <Tab className="min-h-8 text-xs" id="chat">Chat<TabIndicator /></Tab>
              <Tab className="min-h-8 text-xs" id="browser">Browser<TabIndicator /></Tab>
            </TabList>
          </Tabs>
        ) : null}
        <div className="min-h-0 flex-1">
          {hasBrowserActivity && narrowPane === 'browser' ? browser : chat}
        </div>
      </div> : null}
    </section>
  );
}
