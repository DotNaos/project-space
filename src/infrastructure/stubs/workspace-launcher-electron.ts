import type { WorkspaceLauncher } from '@/application/ports/workspace-launcher';

export const workspaceLauncher: WorkspaceLauncher = {
  openTool(input) {
    return window.projectSpace.openWorkspaceTool(input);
  }
};
