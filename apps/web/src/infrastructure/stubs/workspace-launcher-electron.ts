import type { WorkspaceLauncher } from '@/application/ports/workspace-launcher';
import { projectSpaceClient } from '@/api/project-space-client';

export const workspaceLauncher: WorkspaceLauncher = {
  openTool(input) {
    return projectSpaceClient.openWorkspaceTool(input);
  }
};
