import { ExternalLink } from 'lucide-react';
import { Button, Surface, Text } from '@/app/dotnaos-ui';
import type { ProjectWorktreeRecord } from '@/shared/project-space-api';

export function WorktreeGitClientPanel({
  worktree
}: {
  worktree?: ProjectWorktreeRecord;
}) {
  return (
    <Surface variant="tertiary" className="grid gap-3 rounded-lg border border-neutral-800 bg-neutral-950/45 p-4">
      <div className="min-w-0">
        <Text className="block text-sm font-semibold text-neutral-100">Repository</Text>
        <Text className="mt-1 block text-xs leading-5 text-neutral-500">
          {worktree?.path ? 'Local repository browsing remains available from the selected worktree.' : 'Select a worktree to browse its repository.'}
        </Text>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2">
        <Text className="text-sm text-amber-100">
          Git operations need an exact canonical Environment Instance and Workspace Runtime.
        </Text>
        <Button
          size="sm"
          variant="outline"
          onPress={() => window.location.assign('/settings')}
        >
          <ExternalLink className="size-4" />
          Open Compute
        </Button>
      </div>
    </Surface>
  );
}
