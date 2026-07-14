import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode
} from 'react';
import { Surface } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import type {
  ProjectTopologyNavigationActions,
  TopologyExistingTaskActions
} from './project-topology-actions';
import type { TopologyBrowserToolEvents } from './project-topology-browser';
import { subscribeProjectTopologyAutoRefresh } from './project-topology-auto-refresh';
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
import {
  TopologyReadBanner,
  TopologyUnavailable
} from './project-topology-state-overlays';
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
  const refreshPromiseRef = useRef<Promise<ProjectTopologyReadState> | undefined>(undefined);
  const snapshot = snapshotForReadState(readState);
  const selectedTaskId = workspace.target.kind === 'task'
    && (workspace.phase === 'opening'
      || workspace.phase === 'open')
      ? workspace.target.taskId
      : undefined;

  const refreshTopology = useCallback(() => {
    if (refreshPromiseRef.current) return refreshPromiseRef.current;
    const pending = controller.refresh()
      .catch(() => controller.getState())
      .finally(() => {
        if (refreshPromiseRef.current === pending) refreshPromiseRef.current = undefined;
      });
    refreshPromiseRef.current = pending;
    return pending;
  }, [controller]);
  useEffect(() => subscribeProjectTopologyAutoRefresh(refreshTopology), [refreshTopology]);
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
        onRetry={() => void refreshTopology()}
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
      onRefresh={() => void refreshTopology()}
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
  const hasCompactFocus = viewport.width < 640
    && (workspace.target.kind === 'project' || workspace.target.kind === 'machine');
  const canvasHeight = hasCompactFocus
    ? Math.max(240, Math.round(viewport.height * 0.42))
    : viewport.height;
  const layout = useMemo(() => layoutProjectTopology(
    snapshot,
    viewport.width,
    canvasHeight
  ), [canvasHeight, snapshot, viewport.width]);
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
        hasCompactFocus && 'grid grid-rows-[minmax(15rem,42%)_minmax(0,1fr)]',
        hasBottomTabBar && 'pb-[calc(6.75rem+env(safe-area-inset-bottom))]'
      )}
      data-testid="project-topology-command-center"
      variant="transparent"
    >
      <div className={cn('relative min-h-0 overflow-hidden', !hasCompactFocus && 'size-full')}>
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
      </div>
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
          placement={hasCompactFocus ? 'inline' : 'overlay'}
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
