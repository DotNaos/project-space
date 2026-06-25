import { Button } from '@heroui/react';

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
        <Button
          key={action.tool}
          type="button"
          variant="outline"
          onPress={() => onOpen(action.tool)}
          className="justify-start rounded-xl border-slate-700/70 bg-slate-950/30 px-3 py-2 text-left text-slate-100 shadow-none transition hover:border-teal-300/30 hover:bg-teal-300/8"
        >
          <span className="block text-sm font-medium text-inherit">
            {action.label}
          </span>
        </Button>
      ))}
    </div>
  );
}
