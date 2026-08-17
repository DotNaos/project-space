export const CODEX_HOST_INVENTORY_API_VERSION = 1 as const;

export interface CodexHostWorktree {
  branch?: string;
  issueNumber?: number;
  label: string;
  path: string;
  repository?: string;
  threadCount: number;
}

export interface CodexHostInventoryItem {
  addresses: string[];
  machineId: string;
  name: string;
  tailscaleDeviceId: string;
  worktrees: CodexHostWorktree[];
}

export interface CodexHostInventoryResult {
  apiVersion: typeof CODEX_HOST_INVENTORY_API_VERSION;
  checkedAt: string;
  hosts: CodexHostInventoryItem[];
}
