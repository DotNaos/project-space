import {
  useEffect,
  useRef,
  useState,
  type RefObject
} from 'react';
import { createCodexSessionsClient } from '@/api/codex-sessions-client';
import {
  projectSpaceClient,
  refreshProjectSpaceAuthToken
} from '@/api/project-space-client';
import type { ProjectTopologyNavigationActions } from './project-topology-actions';
import { ProjectTopologyCommandCenter } from './project-topology-command-center';
import { createProjectTopologyProductionRouteRuntime } from './project-topology-production-route-runtime';
import { ProjectTopologyReactFlowCanvas } from './project-topology-react-flow-canvas';
import { ProjectTopologyRoutePending } from './project-topology-route-pending';
import type { TopologySize } from './project-topology-layout';
import { loadProjectTopologyWorktreeSnapshot } from './project-topology-inventory-client';

export interface ProjectTopologyProductionRouteProps {
  hasBottomTabBar?: boolean;
  hasHomeViewSwitcher?: boolean;
  navigation: ProjectTopologyNavigationActions;
}

export function ProjectTopologyProductionRoute({
  hasBottomTabBar = false,
  hasHomeViewSwitcher = false,
  navigation
}: ProjectTopologyProductionRouteProps) {
  const routeRef = useRef<HTMLDivElement>(null);
  const viewport = useTopologyRouteViewport(routeRef);
  const [runtime, setRuntime] = useState<ReturnType<
    typeof createProjectTopologyProductionRouteRuntime
  >>();

  useEffect(() => {
    const codex = createCodexSessionsClient({
      getAuthToken: refreshProjectSpaceAuthToken
    });
    const nextRuntime = createProjectTopologyProductionRouteRuntime({
      codex,
      loadProjectWorktreeSnapshot: loadProjectTopologyWorktreeSnapshot,
      projectSpace: projectSpaceClient
    });
    setRuntime(nextRuntime);
    return () => nextRuntime.dispose();
  }, []);

  return (
    <div
      className="h-full min-h-0 overflow-hidden"
      data-testid="project-topology-production-route"
      ref={routeRef}
    >
      {runtime && viewport.width > 0 && viewport.height > 0 ? (
        <ProjectTopologyCommandCenter
          Canvas={ProjectTopologyReactFlowCanvas}
          controller={runtime.controller}
          hasBottomTabBar={hasBottomTabBar}
          hasHomeViewSwitcher={hasHomeViewSwitcher}
          navigation={navigation}
          taskActions={runtime.taskActions}
          transcriptRegistry={runtime.transcriptRegistry}
          viewport={viewport}
        />
      ) : (
        <ProjectTopologyRoutePending hasBottomTabBar={hasBottomTabBar} />
      )}
    </div>
  );
}

function useTopologyRouteViewport(ref: RefObject<HTMLElement | null>) {
  const [viewport, setViewport] = useState<TopologySize>({ height: 0, width: 0 });

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const next = {
        height: Math.max(0, element.clientHeight),
        width: Math.max(0, element.clientWidth)
      };
      setViewport((current) => (
        current.height === next.height && current.width === next.width ? current : next
      ));
    };

    measure();
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(measure);
      observer.observe(element);
      return () => observer.disconnect();
    }
    if (typeof window === 'undefined') return;
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [ref]);

  return viewport;
}
