import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject
} from 'react';
import {
  Handle,
  Position,
  ReactFlow,
  type NodeMouseHandler,
  type NodeProps,
  type ReactFlowInstance,
  type Viewport
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { ProjectTopologyCanvasAdapterProps } from './project-topology-command-center';
import type { TopologySize } from './project-topology-layout';
import { topologySpringProgress, topologyTransitionDuration } from './project-topology-motion';
import {
  sameTopologyViewportRequest,
  topologyReactFlowEdges,
  topologyReactFlowNodes,
  topologyNativePanViewport,
  topologyViewportRequest,
  visibleTopologyTaskIds,
  type TopologyReactFlowEdge,
  type TopologyReactFlowNode,
  type TopologyViewportRequest
} from './project-topology-react-flow-model';

const topologyNodeTypes = { topology: TopologyReactFlowNodeBody };

export function ProjectTopologyReactFlowCanvas({
  layout,
  onNodeActivate,
  onViewportSettled,
  onVisibleTaskIdsChange,
  renderNode,
  snapshot,
  viewport
}: ProjectTopologyCanvasAdapterProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(containerRef);
  const [instance, setInstance] = useState<ReactFlowInstance<
    TopologyReactFlowNode,
    TopologyReactFlowEdge
  > | null>(null);
  const activateRef = useLatest(onNodeActivate);
  const settledRef = useLatest(onViewportSettled);
  const visibleRef = useLatest(onVisibleTaskIdsChange);
  const viewportRef = useLatest(viewport);
  const nodes = useMemo(
    () => topologyReactFlowNodes(layout, snapshot, renderNode),
    [layout, renderNode, snapshot]
  );
  const edges = useMemo(() => topologyReactFlowEdges(layout), [layout]);
  const lastVisibleRef = useRef('');
  const requestSequenceRef = useRef(0);

  const publishVisibleTasks = useCallback((flowViewport: Viewport) => {
    const taskIds = visibleTopologyTaskIds(layout, flowViewport, size);
    const signature = taskIds.join('\u0000');
    if (signature === lastVisibleRef.current) return;
    lastVisibleRef.current = signature;
    visibleRef.current?.(taskIds);
  }, [layout, size, visibleRef]);
  const publishVisibleRef = useLatest(publishVisibleTasks);

  const activateNode = useCallback<NodeMouseHandler<TopologyReactFlowNode>>(
    (_event, node) => activateRef.current(node.data.layoutNode),
    [activateRef]
  );

  useEffect(() => {
    if (!instance || size.width <= 0 || size.height <= 0) return;
    publishVisibleTasks(instance.getViewport());
  }, [instance, nodes, publishVisibleTasks, size.height, size.width]);

  useEffect(() => {
    if (!instance || size.width <= 0 || size.height <= 0) return;
    const sequence = ++requestSequenceRef.current;
    const request = topologyViewportRequest(viewport);
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const duration = topologyTransitionDuration(viewport.spring, reducedMotion);
    const ease = (progress: number) => topologySpringProgress(progress, viewport.spring);
    let cancelled = false;

    void runViewportRequest(instance, request, size, duration, ease)
      .then((completed) => {
        if (!completed
          || cancelled
          || sequence !== requestSequenceRef.current
          || !sameTopologyViewportRequest(request, viewportRef.current)) return;
        publishVisibleRef.current(instance.getViewport());
        settledRef.current({ target: request.target, transition: request.transition });
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      requestSequenceRef.current += 1;
    };
  }, [
    instance,
    publishVisibleRef,
    settledRef,
    size.height,
    size.width,
    viewport.bounds.height,
    viewport.bounds.width,
    viewport.bounds.x,
    viewport.bounds.y,
    viewport.overview.mode,
    viewport.overview.mode === 'native-pan' ? viewport.overview.anchorX : undefined,
    viewport.overview.mode === 'native-pan' ? viewport.overview.zoom : undefined,
    viewport.spring,
    viewport.target,
    viewport.transition,
    viewportRef
  ]);

  return (
    <div className="size-full min-h-0" data-testid="project-topology-react-flow" ref={containerRef}>
      <ReactFlow<TopologyReactFlowNode, TopologyReactFlowEdge>
        autoPanOnConnect={false}
        autoPanOnNodeDrag={false}
        colorMode="dark"
        connectOnClick={false}
        defaultEdgeOptions={{ animated: false }}
        deleteKeyCode={null}
        edges={edges}
        edgesFocusable={false}
        edgesReconnectable={false}
        elementsSelectable={false}
        elevateEdgesOnSelect={false}
        elevateNodesOnSelect={false}
        maxZoom={1.4}
        minZoom={0.2}
        multiSelectionKeyCode={null}
        nodeTypes={topologyNodeTypes}
        nodes={nodes}
        nodesConnectable={false}
        nodesDraggable={false}
        nodesFocusable={false}
        onlyRenderVisibleElements
        onInit={setInstance}
        onMoveEnd={(_event, flowViewport) => publishVisibleTasks(flowViewport)}
        onNodeClick={activateNode}
        panOnDrag
        panOnScroll
        preventScrolling
        proOptions={{ hideAttribution: true }}
        selectionKeyCode={null}
        selectionOnDrag={false}
        zoomOnDoubleClick={false}
        zoomOnPinch
        zoomOnScroll
      />
    </div>
  );
}

function TopologyReactFlowNodeBody({ data }: NodeProps<TopologyReactFlowNode>) {
  const hasIncomingEdge = data.layoutNode.kind === 'project';
  const hasOutgoingEdge = data.layoutNode.kind === 'lead';
  return (
    <div className="relative size-full">
      {hasIncomingEdge ? <TopologyEdgeHandle position={Position.Top} type="target" /> : null}
      <button
        aria-label={data.activationLabel}
        className="nodrag nopan absolute inset-0 z-0 rounded-xl bg-transparent focus-visible:z-[3] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-300"
        data-topology-activation={data.layoutNode.kind}
        type="button"
      />
      <div className="pointer-events-none relative z-[1] size-full [&_.nodrag]:pointer-events-auto [&_.nodrag]:relative [&_.nodrag]:z-[2]">
        {data.content}
      </div>
      {hasOutgoingEdge ? <TopologyEdgeHandle position={Position.Bottom} type="source" /> : null}
    </div>
  );
}

function TopologyEdgeHandle({
  position,
  type
}: {
  position: Position;
  type: 'source' | 'target';
}) {
  return (
    <Handle
      className="pointer-events-none !size-px !min-h-0 !min-w-0 !border-0 !bg-transparent !opacity-0"
      isConnectable={false}
      position={position}
      type={type}
    />
  );
}

async function runViewportRequest(
  instance: ReactFlowInstance<TopologyReactFlowNode, TopologyReactFlowEdge>,
  request: TopologyViewportRequest,
  size: TopologySize,
  duration: number,
  ease: (progress: number) => number
) {
  if (request.kind === 'native-top') {
    return instance.setViewport(
      topologyNativePanViewport(request, size),
      { duration, ease }
    );
  }
  return instance.fitBounds(request.bounds, { duration, ease, padding: 0.08 });
}

function useElementSize(ref: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ height: 0, width: 0 });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      const next = { height: element.clientHeight, width: element.clientWidth };
      setSize((current) => current.height === next.height && current.width === next.width
        ? current
        : next);
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
