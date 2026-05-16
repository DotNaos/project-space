import type { ToolLaunchResult, WorkspaceTool } from '@/shared/project-space-api';

export interface WorkspaceLauncher {
  openTool(input: {
    tool: WorkspaceTool;
    projectId: string;
    worktreeId?: string;
  }): Promise<ToolLaunchResult>;
}
