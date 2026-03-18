import type { ToolLaunchResult, WorkspaceTool } from '@/shared/electron-api';

export interface WorkspaceLauncher {
  openTool(input: {
    tool: WorkspaceTool;
    projectId: string;
    worktreeId?: string;
  }): Promise<ToolLaunchResult>;
}
