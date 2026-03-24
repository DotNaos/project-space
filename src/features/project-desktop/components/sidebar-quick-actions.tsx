import { Button, Text } from '@heroui/react';
import { Blocks, GitBranchPlus, PenSquare, Settings2 } from 'lucide-react';

interface SidebarQuickActionsProps {
  canCreateIdea: boolean;
  canOpenSettings: boolean;
  canCreateWorktree: boolean;
  onCreateIdea(): void;
  onOpenProjectSettings(): void;
  onOpenSkills(): void;
  onOpenWorktree(): void;
}

export function SidebarQuickActions({
  canCreateIdea,
  canOpenSettings,
  canCreateWorktree,
  onCreateIdea,
  onOpenProjectSettings,
  onOpenSkills,
  onOpenWorktree
}: SidebarQuickActionsProps) {
  return (
    <div className="mt-4 space-y-1">
      <Button
        variant="ghost"
        isDisabled={!canCreateIdea}
        onPress={onCreateIdea}
        className="h-11 w-full justify-start gap-3 rounded-2xl px-3 text-zinc-300 transition duration-200 hover:bg-zinc-900/35 hover:text-zinc-50 data-[disabled=true]:opacity-45"
      >
        <PenSquare className="h-4 w-4 shrink-0" strokeWidth={1.9} />
        <Text className="text-[15px] font-medium text-current">New idea</Text>
      </Button>

      <Button
        variant="ghost"
        onPress={onOpenSkills}
        className="h-11 w-full justify-start gap-3 rounded-2xl px-3 text-zinc-300 transition duration-200 hover:bg-zinc-900/35 hover:text-zinc-50"
      >
        <Blocks className="h-4 w-4 shrink-0" strokeWidth={1.9} />
        <Text className="text-[15px] font-medium text-current">Skills</Text>
      </Button>

      <Button
        variant="ghost"
        isDisabled={!canOpenSettings}
        onPress={onOpenProjectSettings}
        className="h-11 w-full justify-start gap-3 rounded-2xl px-3 text-zinc-300 transition duration-200 hover:bg-zinc-900/35 hover:text-zinc-50 data-[disabled=true]:opacity-45"
      >
        <Settings2 className="h-4 w-4 shrink-0" strokeWidth={1.9} />
        <Text className="text-[15px] font-medium text-current">Project settings</Text>
      </Button>

      <Button
        variant="ghost"
        isDisabled={!canCreateWorktree}
        onPress={onOpenWorktree}
        className="h-11 w-full justify-start gap-3 rounded-2xl px-3 text-zinc-300 transition duration-200 hover:bg-zinc-900/35 hover:text-zinc-50 data-[disabled=true]:opacity-45"
      >
        <GitBranchPlus className="h-4 w-4 shrink-0" strokeWidth={1.9} />
        <Text className="text-[15px] font-medium text-current">New worktree</Text>
      </Button>
    </div>
  );
}
