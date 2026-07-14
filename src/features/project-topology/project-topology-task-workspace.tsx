import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent
} from 'react';
import {
  ArrowLeft,
  ArrowUp,
  ChevronDown,
  CircleAlert,
  LoaderCircle,
  Mic,
  Plus,
  ShieldCheck,
  Square,
  X
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
import { cn } from '@/lib/utils';
import {
  TopologyBrowserCapabilityNote,
  TopologyDeveloperTools,
  TopologyReadOnlyBrowserFrame,
  type TopologyBrowserToolEvents
} from './project-topology-browser';
import {
  topologyBoundBrowserCapability,
  topologyTaskHeader
} from './project-topology-presentation';
import { TopologyTranscript } from './project-topology-transcript';
import type { TopologyTask } from './project-topology-types';
import {
  topologyTaskStatuses,
  type TopologyTaskWorkspaceView
} from './project-topology-view-model';
import {
  useTopologyWorkspaceMotion,
  type TopologyWorkspaceMotionControl
} from './project-topology-workspace-motion';

type ComposerView = TopologyTaskWorkspaceView['composer'];

function TaskComposer({
  composer,
  onSend,
  onStop,
  task
}: {
  composer: ComposerView;
  onSend?(message: string): Promise<void> | void;
  onStop?(): Promise<void> | void;
  task: TopologyTask;
}) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const taskIdRef = useRef(task.id);

  useEffect(() => {
    taskIdRef.current = task.id;
    setDraft('');
    setError('');
    setPending(false);
  }, [task.id]);

  const stopping = composer.action === 'stop' && task.interaction.canInterrupt;
  const sending = composer.action === 'send' && task.interaction.canContinue;
  const actionAvailable = stopping ? Boolean(onStop) : sending ? Boolean(onSend) : false;
  if (
    !composer.visible
    || !task.interaction.composerVisible
    || (!stopping && !sending)
    || !actionAvailable
  ) {
    return null;
  }
  const canSend = composer.action === 'send'
    && composer.inputEnabled
    && task.interaction.canContinue
    && Boolean(onSend)
    && Boolean(draft.trim())
    && !pending;
  const canStop = stopping && Boolean(onStop) && !pending;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = draft.trim();
    if (!canSend || !message || !onSend) return;
    const dispatchedTaskId = task.id;
    setPending(true);
    setError('');
    try {
      await onSend(message);
      if (taskIdRef.current === dispatchedTaskId) setDraft('');
    } catch (sendError) {
      if (taskIdRef.current === dispatchedTaskId) {
        setError(sendError instanceof Error ? sendError.message : 'The follow-up was not sent.');
      }
    } finally {
      if (taskIdRef.current === dispatchedTaskId) setPending(false);
    }
  }

  async function stop() {
    if (!canStop || !onStop) return;
    const dispatchedTaskId = task.id;
    setPending(true);
    setError('');
    try {
      await onStop();
    } catch (stopError) {
      if (taskIdRef.current === dispatchedTaskId) {
        setError(stopError instanceof Error ? stopError.message : 'The current turn was not stopped.');
      }
    } finally {
      if (taskIdRef.current === dispatchedTaskId) setPending(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  return (
    <form
      className="shrink-0 border-t border-neutral-800/80 bg-neutral-950 px-3 pb-3 pt-2.5 sm:px-4"
      data-topology-composer="writable"
      onSubmit={submit}
    >
      <div className="rounded-[22px] border border-neutral-700/80 bg-neutral-900/90 px-3 pb-2.5 pt-2.5 shadow-[0_18px_48px_rgba(0,0,0,0.3)] focus-within:border-neutral-500">
        <textarea
          aria-label={`Continue ${task.agentLabel}'s Codex task`}
          className="min-h-14 w-full resize-none bg-transparent px-1 text-[13px] leading-5 text-neutral-100 outline-none placeholder:text-neutral-600 disabled:cursor-not-allowed disabled:text-neutral-600"
          disabled={!composer.inputEnabled || pending}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={handleKeyDown}
          placeholder={stopping
            ? 'This task is running. Stop the current turn before sending a follow-up.'
            : 'Ask for follow-up changes'}
          rows={2}
          value={draft}
        />
        <div className="mt-1 flex min-w-0 items-center gap-1.5">
          <span
            aria-label={`${composer.context.label} context is locked`}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-neutral-500"
            title={`${composer.context.label} context is locked`}
          >
            <Plus className="size-4" />
          </span>
          <span
            aria-label={composer.security.label}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-amber-400/80"
            title={composer.security.label}
          >
            <ShieldCheck className="size-3.5" />
          </span>
          <span
            aria-label={`${composer.model.label} model is read-only`}
            className="ml-auto flex min-w-0 max-w-24 items-center gap-1 text-[10px] text-neutral-400 sm:max-w-32"
            title={`${composer.model.label} model is read-only`}
          >
            <Text className="truncate">{composer.model.label}</Text>
            <ChevronDown className="size-3 shrink-0" />
          </span>
          <span
            aria-label={composer.microphone.reason}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-neutral-600"
            title={composer.microphone.reason}
          >
            <Mic className="size-4" />
          </span>
          <Button
            aria-label={stopping ? 'Stop current Codex turn' : 'Send follow-up to this Codex task'}
            className={cn(
              'size-8 min-h-0 rounded-full',
              stopping && 'bg-red-100 text-red-950 hover:bg-white'
            )}
            isDisabled={stopping ? !canStop : !canSend}
            isIconOnly
            onPress={stopping ? () => void stop() : undefined}
            size="sm"
            type={stopping ? 'button' : 'submit'}
            variant={stopping ? 'danger' : 'primary'}
          >
            {pending ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : stopping ? (
              <Square className="size-3 fill-current" />
            ) : (
              <ArrowUp className="size-4" />
            )}
          </Button>
        </div>
      </div>
      {error ? (
        <div aria-live="polite" className="mt-2 flex items-center gap-1.5 px-2 text-[10px] text-red-300" role="alert">
          <CircleAlert className="size-3 shrink-0" />
          <Text>{error}</Text>
        </div>
      ) : null}
    </form>
  );
}

function ComposerCapabilityNote({ reason }: { reason?: string }) {
  if (!reason) return null;
  return (
    <div
      className="flex shrink-0 items-start gap-2 border-t border-neutral-800/80 bg-neutral-950 px-4 py-2.5 text-[11px] leading-4 text-neutral-400"
      data-topology-composer="unavailable"
      role="status"
    >
      <ShieldCheck aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-neutral-500" />
      <Text>{reason}</Text>
    </div>
  );
}

function ConversationPane({
  onSend,
  onStop,
  task,
  view
}: {
  onSend?(message: string): Promise<void> | void;
  onStop?(): Promise<void> | void;
  task: TopologyTask;
  view: TopologyTaskWorkspaceView;
}) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-neutral-950">
      <TopologyTranscript transcript={task.transcript} />
      {view.composer.visible ? (
        <TaskComposer composer={view.composer} onSend={onSend} onStop={onStop} task={task} />
      ) : (
        <ComposerCapabilityNote reason={view.composer.reason} />
      )}
    </div>
  );
}

function BrowserPane({
  eventsByTool,
  task,
  view
}: {
  eventsByTool?: TopologyBrowserToolEvents;
  task: TopologyTask;
  view: TopologyTaskWorkspaceView & { browser: NonNullable<TopologyTaskWorkspaceView['browser']> };
}) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col border-neutral-800 bg-neutral-950">
      <div className="min-h-0 flex-1">
        <TopologyReadOnlyBrowserFrame frameUrl={view.browser.frameUrl} title={task.title} />
      </div>
      <TopologyDeveloperTools eventsByTool={eventsByTool} tools={view.tools} />
    </div>
  );
}

function NarrowWorkspace({
  eventsByTool,
  onSend,
  onStop,
  task,
  view
}: {
  eventsByTool?: TopologyBrowserToolEvents;
  onSend?(message: string): Promise<void> | void;
  onStop?(): Promise<void> | void;
  task: TopologyTask;
  view: TopologyTaskWorkspaceView & { browser: NonNullable<TopologyTaskWorkspaceView['browser']> };
}) {
  const [pane, setPane] = useState<'browser' | 'conversation'>('conversation');
  useEffect(() => setPane('conversation'), [task.id]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Tabs
        className="shrink-0 border-b border-neutral-800 bg-neutral-950 px-2"
        onSelectionChange={(key) => setPane(key as typeof pane)}
        selectedKey={pane}
      >
        <TabList aria-label="Task command center panes" className="flex h-10 items-center">
          <Tab className="min-h-8 text-xs" id="conversation">
            Conversation<TabIndicator />
          </Tab>
          <Tab className="min-h-8 text-xs" id="browser">
            Browser<TabIndicator />
          </Tab>
        </TabList>
      </Tabs>
      <div
        aria-label={pane === 'conversation' ? 'Conversation pane' : 'Browser pane'}
        className="flex min-h-0 flex-1"
        role="tabpanel"
      >
        {pane === 'conversation' ? (
          <ConversationPane onSend={onSend} onStop={onStop} task={task} view={view} />
        ) : (
          <BrowserPane eventsByTool={eventsByTool} task={task} view={view} />
        )}
      </div>
    </div>
  );
}

export interface TopologyTaskCommandCenterProps {
  eventsByTool?: TopologyBrowserToolEvents;
  motion?: TopologyWorkspaceMotionControl;
  onClose(): void;
  onSend?(message: string): Promise<void> | void;
  onStop?(): Promise<void> | void;
  task: TopologyTask;
  view: TopologyTaskWorkspaceView;
}

export function TopologyTaskCommandCenter({
  eventsByTool,
  motion,
  onClose,
  onSend,
  onStop,
  task,
  view
}: TopologyTaskCommandCenterProps) {
  const sectionRef = useRef<HTMLElement>(null);
  useTopologyWorkspaceMotion(sectionRef, task.id, motion);
  const header = topologyTaskHeader(task);
  const statuses = topologyTaskStatuses(task);
  const browserCapability = topologyBoundBrowserCapability(task);
  const browserView = browserCapability.state === 'ready'
    && view.browser
    && view.browser.frameUrl === browserCapability.frameUrl
    && view.browser.sessionId === browserCapability.sessionId
    ? {
        ...view,
        browser: view.browser,
        tools: view.tools.filter((tool) => {
          const capability = browserCapability.state === 'ready'
            ? browserCapability.tools[tool.kind]
            : undefined;
          return capability?.checkedAt === tool.checkedAt
            && capability.streamUrl === tool.streamUrl;
        })
      }
    : undefined;
  const activityDotClass = statuses.activity.tone === 'success'
    ? 'bg-emerald-400'
    : statuses.activity.tone === 'danger'
      ? 'bg-red-400'
      : statuses.activity.tone === 'warning'
        ? 'bg-amber-300'
        : 'bg-neutral-500';

  return (
    <section
      aria-label={`${header.issueLabel ?? header.title} task command center`}
      className="nodrag nopan nowheel flex size-full min-h-0 min-w-0 origin-center flex-col overflow-hidden rounded-xl border border-neutral-700 bg-neutral-950 shadow-[0_32px_100px_rgba(0,0,0,0.7)] motion-reduce:transform-none"
      data-topology-command-center={task.id}
      ref={sectionRef}
      style={motion?.phase === 'opening'
        ? { opacity: 0, transform: 'translateY(18px) scale(0.955)' }
        : undefined}
    >
      <header className="flex h-14 shrink-0 min-w-0 items-center gap-2 border-b border-neutral-800/80 px-3 sm:gap-3 sm:px-4">
        <Button
          aria-label="Back to project topology"
          className="size-8 min-h-0"
          isIconOnly
          onPress={onClose}
          size="sm"
          variant="outline"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
        </Button>
        <span className="min-w-0">
          <Text as="h2" className="block truncate text-xs font-semibold text-neutral-100 sm:text-sm">
            {header.issueLabel ? `${header.issueLabel} · ` : ''}{header.title}
          </Text>
          <span className="mt-1 flex min-w-0 items-center gap-2 text-[9px] text-neutral-400">
            <span className={cn(
              'size-1.5 shrink-0 rounded-full',
              activityDotClass
            )} />
            <Text className="truncate">{header.agentLabel} · {statuses.activity.label}</Text>
          </span>
        </span>
        {header.branchName ? (
          <Chip className="max-w-20 shrink truncate sm:max-w-52" size="sm">
            {header.branchName}
          </Chip>
        ) : null}
        <span className="ml-auto hidden max-w-48 sm:block">
          <TopologyBrowserCapabilityNote browser={browserCapability} />
        </span>
        <span className="ml-auto max-w-24 sm:hidden">
          <TopologyBrowserCapabilityNote browser={browserCapability} compact />
        </span>
        <Button
          aria-label="Close task command center"
          className="size-8 min-h-0"
          isIconOnly
          onPress={onClose}
          size="sm"
          variant="ghost"
        >
          <X aria-hidden="true" className="size-4" />
        </Button>
      </header>

      {browserView ? (
        view.mode === 'split' ? (
          <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,0.78fr)_minmax(0,1.22fr)]">
            <ConversationPane onSend={onSend} onStop={onStop} task={task} view={view} />
            <div className="min-h-0 border-l border-neutral-800/80">
              <BrowserPane eventsByTool={eventsByTool} task={task} view={browserView} />
            </div>
          </div>
        ) : (
          <NarrowWorkspace
            eventsByTool={eventsByTool}
            onSend={onSend}
            onStop={onStop}
            task={task}
            view={browserView}
          />
        )
      ) : (
        <ConversationPane onSend={onSend} onStop={onStop} task={task} view={view} />
      )}
    </section>
  );
}
