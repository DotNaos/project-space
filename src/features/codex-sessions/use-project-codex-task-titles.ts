import { useMemo, useSyncExternalStore } from 'react';
import type { ProjectSpaceRecord } from '@/shared/project-space-api';
import type { CodexSessionsController } from './codex-sessions-controller';
import { projectCodexTasks } from './project-codex-task-model';

export interface ProjectCodexTaskTitle {
  machineId: string;
  threadId: string;
  title: string;
}

export function useProjectCodexTaskTitles(
  controller: CodexSessionsController,
  projectRecords: readonly ProjectSpaceRecord[]
): ProjectCodexTaskTitle[] {
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);

  return useMemo(
    () => projectCodexTasks(state.sessions, projectRecords).map((task) => ({
      machineId: task.machineId,
      threadId: task.threadId,
      title: task.title
    })),
    [projectRecords, state.sessions]
  );
}
