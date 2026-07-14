import type { TopologyBrowserToolEvents } from './project-topology-browser';
import {
  useTopologyLiveTranscript,
  type ProjectTopologyTranscriptRegistry
} from './project-topology-live-transcript';
import { TopologyTaskNodeBody } from './project-topology-node-bodies';
import {
  TopologyTaskCommandCenter,
  type TopologyTaskCommandCenterProps
} from './project-topology-task-workspace';
import type { TopologyTask } from './project-topology-types';
import { topologyTaskWorkspace } from './project-topology-view-model';

export function TopologyLiveTaskNode({
  active,
  focused,
  onOpen,
  registry,
  task
}: {
  active: boolean;
  focused?: boolean;
  onOpen(): void;
  registry?: ProjectTopologyTranscriptRegistry;
  task: TopologyTask;
}) {
  const liveTask = useTopologyLiveTranscript(registry, task, active);
  return (
    <TopologyTaskNodeBody focused={focused} onOpen={onOpen} task={liveTask} />
  );
}

export function TopologyLiveTaskCommandCenter({
  actionsAvailable,
  eventsByTool,
  motion,
  onClose,
  onRefresh,
  onSend,
  onStop,
  registry,
  task,
  viewportWidth
}: {
  actionsAvailable: boolean;
  eventsByTool?: TopologyBrowserToolEvents;
  motion?: TopologyTaskCommandCenterProps['motion'];
  onClose(): void;
  onRefresh(): void;
  onSend?(task: TopologyTask, message: string): Promise<unknown>;
  onStop?(task: TopologyTask): Promise<unknown>;
  registry?: ProjectTopologyTranscriptRegistry;
  task: TopologyTask;
  viewportWidth: number;
}) {
  const liveTask = useTopologyLiveTranscript(registry, task, true, onRefresh);
  return (
    <TopologyTaskCommandCenter
      eventsByTool={eventsByTool}
      motion={motion}
      onClose={onClose}
      onSend={onSend
        ? async (message) => {
            await onSend(liveTask, message);
            onRefresh();
          }
        : undefined}
      onStop={onStop
        ? async () => {
            await onStop(liveTask);
            onRefresh();
          }
        : undefined}
      task={liveTask}
      view={topologyTaskWorkspace(liveTask, { actionsAvailable, viewportWidth })}
    />
  );
}
