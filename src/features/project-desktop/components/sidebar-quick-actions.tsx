import { Button, Text } from '@/app/dotnaos-ui';
import { Blocks, GitBranchPlus } from 'lucide-react';

interface SidebarQuickActionsProps {
  canCreateWorktree: boolean;
  onOpenSkills(): void;
  onOpenWorktree(): void;
}

export function SidebarQuickActions({
  canCreateWorktree,
  onOpenSkills,
  onOpenWorktree
}: SidebarQuickActionsProps) {
  return (
    <div className="mt-4 space-y-1">
      <Button
        variant="ghost"
        onPress={onOpenSkills}
        className="h-11 w-full justify-start gap-3 rounded-2xl px-3 text-slate-300 transition duration-200 hover:bg-slate-900/35 hover:text-slate-50"
      >
        <Blocks className="h-4 w-4 shrink-0" strokeWidth={1.9} />
        <Text className="text-[15px] font-medium text-current">Skills</Text>
      </Button>

      <Button
        variant="ghost"
        isDisabled={!canCreateWorktree}
        onPress={onOpenWorktree}
        className="h-11 w-full justify-start gap-3 rounded-2xl px-3 text-slate-300 transition duration-200 hover:bg-slate-900/35 hover:text-slate-50 data-[disabled=true]:opacity-45"
      >
        <GitBranchPlus className="h-4 w-4 shrink-0" strokeWidth={1.9} />
        <Text className="text-[15px] font-medium text-current">New worktree</Text>
      </Button>
    </div>
  );
}
