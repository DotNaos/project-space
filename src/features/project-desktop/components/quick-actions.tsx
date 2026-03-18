import type { WorkspaceTool } from '@/shared/electron-api';

interface QuickActionsProps {
  onOpen(tool: WorkspaceTool): void;
}

const actionLabels: Array<{ tool: WorkspaceTool; label: string }> = [
  { tool: 'ide', label: 'Open IDE' },
  { tool: 'terminal', label: 'Open Terminal' },
  { tool: 'git', label: 'Open Git' },
  { tool: 'dev-server', label: 'Open Dev Server' }
];

export function QuickActions({ onOpen }: QuickActionsProps) {
  return (
    <div className="flex flex-wrap gap-2">
      {actionLabels.map((action) => (
        <button
          key={action.tool}
          type="button"
          onClick={() => onOpen(action.tool)}
          className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-left transition hover:border-teal-300/30 hover:bg-teal-300/8"
        >
          <span className="block text-sm font-medium text-white">{action.label}</span>
        </button>
      ))}
    </div>
  );
}
