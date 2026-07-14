import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode
} from 'react';
import { CircleAlert, LoaderCircle, RefreshCw, TriangleAlert } from 'lucide-react';
import { Button, Surface, Text } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import type {
  ProjectTopologyNavigationActions,
  TopologyExistingTaskActions
} from './project-topology-actions';
import type { TopologyBrowserToolEvents } from './project-topology-browser';
import {
  layoutProjectTopology,
  topologyFocusBounds,
  type ProjectTopologyLayout,
  type TopologyBounds,
  type TopologyFocusTarget,
  type TopologyLayoutNode,
  type TopologySize
} from './project-topology-layout';
import { ProjectTopologyFocusPanel } from './project-topology-focus-panel';
import { topologySprings, type TopologySpring } from './project-topology-motion';
import {
  initialTopologyNavigationState,
  reduceTopologyNavigation,
  resolveTopologyTarget,
  topologyNavigationBindings
} from './project-topology-navigation';
import {
  TopologyLeadNodeBody,
  TopologyMachineNodeBody,
  TopologyProjectNodeBody
} from './project-topology-node-bodies';
import {
  TopologyLiveTaskCommandCenter,
  TopologyLiveTaskNode
} from './project-topology-live-task';
import type { ProjectTopologyTranscriptRegistry } from './project-topology-live-transcript';
import { ProjectTopologyRoutePending } from './project-topology-route-pending';
import type {
  ProjectTopologyReadState,
  ProjectTopologySnapshot,
  TopologyTask
} from './project-topology-types';

export interface ProjectTopologyStore {
  getSelectedTask(taskId: string): TopologyTask | undefined;
  getState(): ProjectTopologyReadState;
  refresh(): Promise<ProjectTopologyReadState>;
  selectTask(taskId?: string): Promise<ProjectTopologyReadState>;
  subscribe(listener: () => void): () => void;
}

export interface ProjectTopologyCanvasAdapterProps {
  layout: ProjectTopologyLayout;
  onNodeActivate(node: TopologyLayoutNode): void;
  onVisibleTaskIdsChange?(taskIds: string[]): void;
  onViewportSettled(result: {
    target: TopologyFocusTarget;
    transition: number;
  }): void;
  renderNode(node: TopologyLayoutNode): ReactNode;
  snapshot: ProjectTopologySnapshot;
  viewport: {
    bounds: TopologyBounds;
    overview: ProjectTopologyLayout['overviewViewport'];
    spring: TopologySpring;
    target: TopologyFocusTarget;
    transition: number;
  };
}

export interface ProjectTopologyCommandCenterProps {
  Canvas: ComponentType<ProjectTopologyCanvasAdapterProps>;
  controller: ProjectTopologyStore;
  eventsByTaskId?: Record<string, TopologyBrowserToolEvents | undefined>;
  hasBottomTabBar?: boolean;
  navigation: ProjectTopologyNavigationActions;
  taskActions?: Pick<TopologyExistingTaskActions<unknown>, 'continue' | 'interrupt'>;
  transcriptRegistry?: ProjectTopologyTranscriptRegistry;
  viewport: TopologySize;
}

export function ProjectTopologyCommandCenter({
  Canvas,
  controller,
  eventsByTaskId,
  hasBottomTabBar = false,
  navigation,
  taskActions,
  transcriptRegistry,
  viewport
}: ProjectTopologyCommandCenterProps) {
  const readState = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState
  );
  const [workspace, dispatch] = useReducer(
    reduceTopologyNavigation,
    undefined,
    initialTopologyNavigationState
  );
  const bindings = useMemo(() => topologyNavigationBindings(dispatch), []);
  const snapshot = snapshotForReadState(readState);
  const selectedTaskId = workspace.target.kind === 'task'
    && (workspace.phase === 'opening'
      || workspace.phase === 'open')
      ? workspace.target.taskId
      : undefined;

  useEffect(() => {
    void controller.refresh().catch(() => undefined);
  }, [controller]);
  useEffect(() => {
    dispatch({ snapshot, type: 'snapshot-changed' });
  }, [snapshot]);
  useEffect(() => {
    void controller.selectTask(selectedTaskId).catch(() => undefined);
    return () => {
      void controller.selectTask().catch(() => undefined);
    };
  }, [controller, selectedTaskId]);

  if (readState.state === 'checking' && !readState.previous) {
    return <ProjectTopologyRoutePending hasBottomTabBar={hasBottomTabBar} />;
  }
  if (readState.state === 'blocked') {
    return (
      <TopologyUnavailable
        hasBottomTabBar={hasBottomTabBar}
        onRetry={() => void controller.refresh()}
        reason={readState.reason}
      />
    );
  }
  if (!snapshot) return <ProjectTopologyRoutePending hasBottomTabBar={hasBottomTabBar} />;

  return (
    <TopologySnapshotScene
      Canvas={Canvas}
      bindings={bindings}
      controller={controller}
      eventsByTaskId={eventsByTaskId}
      hasBottomTabBar={hasBottomTabBar}
      navigation={navigation}
      onRefresh={() => void controller.refresh()}
      readState={readState}
      snapshot={snapshot}
      taskActions={taskActions}
      transcriptRegistry={transcriptRegistry}
      viewport={viewport}
      workspace={workspace}
    />
  );
}

interface SnapshotSceneProps extends Omit<
  ProjectTopologyCommandCenterProps,
  'controller'
> {
  bindings: ReturnType<typeof topologyNavigationBindings>;
  controller: ProjectTopologyStore;
  onRefresh(): void;
  readState: ProjectTopologyReadState;
  snapshot: ProjectTopologySnapshot;
  workspace: ReturnType<typeof initialTopologyNavigationState>;
}

function TopologySnapshotScene({
  Canvas,
  bindings,
  controller,
  eventsByTaskId,
  hasBottomTabBar,
  navigation,
  onRefresh,
  readState,
  snapshot,
  taskActions,
  transcriptRegistry,
  viewport,
  workspace
}: SnapshotSceneProps) {
  const layout = useMemo(() => layoutProjectTopology(
    snapshot,
    viewport.width,
    viewport.height
  ), [snapshot, viewport.height, viewport.width]);
  const [visibleTaskIds, setVisibleTaskIds] = useState<ReadonlySet<string>>(() => new Set());
  const currentTaskIds = useMemo(() => new Set(snapshot.projects.flatMap((project) => (
    project.machines.flatMap((machine) => machine.tasks.map((task) => task.id))
  ))), [snapshot]);
  const resolved = resolveTopologyTarget(snapshot, workspace.target);
  const bounds = topologyFocusBounds(layout, workspace.target) ?? layout.bounds;
  const workspacePhase = workspace.phase === 'opening'
    || workspace.phase === 'open'
    || workspace.phase === 'closing'
      ? workspace.phase
      : undefined;
  const workspaceTask = workspace.target.kind === 'task' && workspacePhase
      ? resolved.task
      : undefined;

  const openCoordinator = useCallback((kind: 'lead' | 'project', projectId?: string) => {
    if (kind === 'lead') {
      navigation.openCoordinator({ kind: 'lead' });
      return;
    }
    const project = snapshot.projects.find((candidate) => candidate.id === projectId);
    if (project) {
      navigation.openCoordinator({
        chatProjectId: project.chatProjectId,
        kind: 'project-lead',
        projectId: project.id
      });
    }
  }, [navigation, snapshot.projects]);

  function activateNode(node: TopologyLayoutNode) {
    if (node.kind === 'lead') return openCoordinator('lead');
    if (node.kind === 'project') return bindings.focusProject(node.projectId);
    if (node.kind === 'machine') return bindings.focusMachine(node.projectId, node.machineId);
    bindings.openTask(node.taskId);
  }

  function renderNode(node: TopologyLayoutNode) {
    if (node.kind === 'lead') {
      return (
        <TopologyLeadNodeBody
          lead={snapshot.lead}
          onOpenConversation={() => openCoordinator('lead')}
          summary={snapshot.summary}
        />
      );
    }
    if (node.kind === 'project') {
      const project = snapshot.projects.find((candidate) => candidate.id === node.projectId);
      return project ? (
        <TopologyProjectNodeBody
          focused={isNodeFocused(node, workspace.target, resolved)}
          onOpenConversation={() => openCoordinator('project', project.id)}
          project={project}
        />
      ) : null;
    }
    if (node.kind === 'machine') {
      const project = snapshot.projects.find((candidate) => candidate.id === node.projectId);
      const machine = project?.machines.find((candidate) => candidate.id === node.machineId);
      return machine ? (
        <TopologyMachineNodeBody
          focused={isNodeFocused(node, workspace.target, resolved)}
          machine={machine}
        />
      ) : null;
    }
    const task = resolveTopologyTarget(snapshot, { kind: 'task', taskId: node.taskId }).task;
    return task ? (
      <TopologyLiveTaskNode
        active={visibleTaskIds.has(task.id)}
        focused={isNodeFocused(node, workspace.target, resolved)}
        onOpen={() => bindings.openTask(task.id)}
        registry={transcriptRegistry}
        task={task}
      />
    ) : null;
  }

  return (
    <Surface
      className={cn(
        'relative size-full min-h-0 overflow-hidden rounded-none bg-app-panel',
        hasBottomTabBar && 'pb-[calc(6.75rem+env(safe-area-inset-bottom))]'
      )}
      data-testid="project-topology-command-center"
      variant="transparent"
    >
      <Canvas
        layout={layout}
        onNodeActivate={activateNode}
        onVisibleTaskIdsChange={(taskIds) => {
          const next = new Set(taskIds.filter((taskId) => currentTaskIds.has(taskId)).slice(0, 32));
          setVisibleTaskIds((current) => sameSet(current, next) ? current : next);
        }}
        onViewportSettled={({ target, transition }) => {
          bindings.viewportSettled(target, transition);
        }}
        renderNode={renderNode}
        snapshot={snapshot}
        viewport={{
          bounds,
          overview: layout.overviewViewport,
          spring: topologySprings.focus,
          target: workspace.target,
          transition: workspace.transition
        }}
      />
      <TopologyReadBanner onRefresh={onRefresh} readState={readState} snapshot={snapshot} />
      {workspace.target.kind === 'project' || workspace.target.kind === 'machine' ? (
        <ProjectTopologyFocusPanel
          hasBottomTabBar={hasBottomTabBar}
          onFocusMachine={bindings.focusMachine}
          onFocusOverview={() => {
            bindings.focusOverview();
            navigation.resetFocus();
          }}
          onFocusProject={bindings.focusProject}
          onOpenIssue={navigation.openIssue}
          onOpenProjectConversation={(project) => openCoordinator('project', project.id)}
          onOpenTask={bindings.openTask}
          snapshot={snapshot}
          target={workspace.target}
        />
      ) : null}
      {workspaceTask ? (
        <div className={cn(
          'absolute inset-x-2 top-2 z-50 sm:inset-x-3 sm:top-3',
          hasBottomTabBar
            ? 'bottom-[calc(6.75rem+env(safe-area-inset-bottom))]'
            : 'bottom-2 sm:bottom-3'
        )}>
          <TopologyLiveTaskCommandCenter
            actionsAvailable={Boolean(taskActions)}
            eventsByTool={eventsByTaskId?.[workspaceTask.id]}
            motion={{
              onSettled: bindings.workspaceSettled,
              phase: workspacePhase!,
              transition: workspace.transition
            }}
            onClose={() => {
              void controller.selectTask().catch(() => undefined);
              bindings.closeTask();
            }}
            onRefresh={onRefresh}
            onSend={taskActions ? (_task, message) => {
              if (!_task.interaction.canContinue || !_task.interaction.composerVisible) {
                throw new Error(
                  _task.interaction.reason ?? 'The live Codex task is not writable.'
                );
              }
              const selectedTask = controller.getSelectedTask(workspaceTask.id);
              if (!selectedTask) {
                throw new Error('This Codex task is no longer selected or writable.');
              }
              return taskActions.continue(selectedTask, message);
            } : undefined}
            onStop={taskActions ? (_task) => {
              if (!_task.interaction.canInterrupt || !_task.interaction.composerVisible) {
                throw new Error(
                  _task.interaction.reason ?? 'The live Codex turn cannot be stopped safely.'
                );
              }
              const selectedTask = controller.getSelectedTask(workspaceTask.id);
              if (!selectedTask) {
                throw new Error('This Codex task is no longer selected or writable.');
              }
              return taskActions.interrupt(selectedTask);
            } : undefined}
            registry={transcriptRegistry}
            task={workspaceTask}
            viewportWidth={viewport.width}
          />
        </div>
      ) : null}
    </Surface>
  );
}

function TopologyReadBanner({
  onRefresh,
  readState,
  snapshot
}: {
  onRefresh(): void;
  readState: ProjectTopologyReadState;
  snapshot: ProjectTopologySnapshot;
}) {
  const content = readState.state === 'checking'
    ? { icon: LoaderCircle, label: 'Refreshing topology evidence', tone: 'neutral' as const }
    : readState.state === 'stale'
      ? { icon: TriangleAlert, label: readState.reason, tone: 'warning' as const }
      : snapshot.warnings[0]
        ? {
            icon: TriangleAlert,
            label: snapshot.warnings.length === 1
              ? snapshot.warnings[0].message
              : `${snapshot.warnings[0].message} · +${snapshot.warnings.length - 1} more`,
            tone: 'warning' as const
          }
        : undefined;
  if (!content) return null;
  const Icon = content.icon;
  return (
    <div
      aria-live="polite"
      className={cn(
        'app-no-drag absolute left-1/2 top-3 z-40 flex max-w-[min(42rem,calc(100%-1.5rem))] -translate-x-1/2 items-center gap-2 rounded-full border bg-neutral-950/95 px-3 py-2 text-xs shadow-xl backdrop-blur',
        content.tone === 'warning'
          ? 'border-amber-900/70 text-amber-200'
          : 'border-neutral-800 text-neutral-300'
      )}
      role={readState.state === 'stale' ? 'alert' : 'status'}
      title={snapshot.warnings.map((warning) => warning.message).join('\n')}
    >
      <Icon
        aria-hidden="true"
        className={cn('size-3.5 shrink-0', readState.state === 'checking' && 'animate-spin')}
      />
      <Text className="truncate">{content.label}</Text>
      <Button
        aria-label="Refresh topology evidence"
        className="size-7 min-h-0 shrink-0"
        isIconOnly
        onPress={onRefresh}
        size="sm"
        variant="ghost"
      >
        <RefreshCw aria-hidden="true" className="size-3.5" />
      </Button>
    </div>
  );
}

function TopologyUnavailable({
  hasBottomTabBar,
  onRetry,
  reason
}: {
  hasBottomTabBar: boolean;
  onRetry(): void;
  reason: string;
}) {
  return (
    <Surface
      className={cn(
        'flex size-full min-h-0 items-start rounded-none bg-app-panel px-4 py-4 sm:px-6',
        hasBottomTabBar && 'pb-[calc(6.75rem+env(safe-area-inset-bottom))]'
      )}
      data-testid="project-topology-blocked"
      variant="transparent"
    >
      <div className="app-no-drag flex max-w-xl items-start gap-3" role="alert">
        <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-red-300" />
        <span className="min-w-0">
          <Text as="h1" className="block text-sm font-semibold text-neutral-100">
            Topology evidence is blocked
          </Text>
          <Text className="mt-1 block text-xs leading-5 text-neutral-400">{reason}</Text>
          <Button className="mt-3" onPress={onRetry} size="sm" variant="outline">
            <RefreshCw aria-hidden="true" className="size-3.5" />
            Retry
          </Button>
        </span>
      </div>
    </Surface>
  );
}

function snapshotForReadState(state: ProjectTopologyReadState) {
  if (state.state === 'checking') return state.previous;
  return state.state === 'ready' || state.state === 'stale' ? state.snapshot : undefined;
}

function isNodeFocused(
  node: TopologyLayoutNode,
  target: TopologyFocusTarget,
  resolved: ReturnType<typeof resolveTopologyTarget>
) {
  if (node.kind === 'lead') return target.kind === 'overview';
  if (node.kind === 'project') return resolved.project?.id === node.projectId;
  if (node.kind === 'machine') {
    return resolved.project?.id === node.projectId && resolved.machine?.id === node.machineId;
  }
  return resolved.task?.id === node.taskId;
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}
