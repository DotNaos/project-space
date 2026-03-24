import {
  Chip,
  ListBox,
  ListBoxItem,
  ScrollShadow,
  Surface,
  Text
} from '@heroui/react';
import { cn } from '@/lib/utils';
import type {
  ExplorerTarget,
  ProjectIssueSourceConfig,
  ProjectSpaceRecord,
  ProjectWorktreeRecord
} from '@/shared/electron-api';
import { ProjectIssueSourceLinkButton } from './project-issue-source-link-button';

interface WorkflowExplorerProps {
  issueSourceConfig: ProjectIssueSourceConfig;
  onSelectWorkspace(): void;
  onOpenIssueSource(): void;
  project?: ProjectSpaceRecord;
  selectedExplorerTarget: ExplorerTarget;
  worktrees: ProjectWorktreeRecord[];
  onSelectWorktree(worktreeId: string): void;
}

interface TreeNodeProps {
  id: string;
  label: string;
  level: number;
  selected: boolean;
  badge?: string;
  tone?: 'default' | 'base' | 'broken';
}

function TreeNode({
  id,
  label,
  level,
  selected,
  badge,
  tone = 'default'
}: TreeNodeProps) {
  return (
    <ListBoxItem
      id={id}
      textValue={label}
      className={cn(
        'rounded-xl transition',
        selected
          ? 'bg-zinc-700/70 text-zinc-50'
          : tone === 'base'
            ? 'bg-zinc-500/6 text-zinc-100 hover:bg-zinc-500/10'
            : tone === 'broken'
              ? 'bg-zinc-500/6 text-zinc-100 hover:bg-zinc-500/10'
              : 'text-zinc-400 hover:bg-zinc-800/70 hover:text-zinc-100'
      )}
    >
      <div
        className="flex w-full items-center gap-2 py-2 pr-3 text-left"
        style={{ paddingLeft: `${level * 16 + 14}px` }}
      >
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{label}</span>
      {badge ? (
        <Chip
          color={
            tone === 'base' ? 'success' : tone === 'broken' ? 'warning' : 'default'
          }
          size="sm"
          variant="soft"
          className="shrink-0 uppercase tracking-[0.16em]"
        >
          {badge}
        </Chip>
      ) : null}
      </div>
    </ListBoxItem>
  );
}

export function WorkflowExplorer({
  issueSourceConfig,
  onSelectWorkspace,
  onOpenIssueSource,
  project,
  selectedExplorerTarget,
  worktrees,
  onSelectWorktree
}: WorkflowExplorerProps) {
  const activeItemId =
    selectedExplorerTarget.kind === 'workspace'
      ? 'workspace'
      : `worktree:${selectedExplorerTarget.worktreeId}`;

  return (
    <ScrollShadow className="flex-1 px-3 py-4" hideScrollBar>
      {project ? (
        <div className="space-y-3">
          <Surface variant="transparent" className="px-3 py-2">
            <Text className="text-[11px] font-medium uppercase tracking-[0.18em] text-zinc-500">
              Project
            </Text>
            <div className="mt-2 flex items-center justify-between gap-2">
              <Text className="block min-w-0 truncate text-sm font-semibold text-zinc-100">
                {project.name}
              </Text>
              <ProjectIssueSourceLinkButton
                kind={issueSourceConfig.kind}
                onPress={onOpenIssueSource}
                url={issueSourceConfig.url}
              />
            </div>
          </Surface>

          <ListBox
            aria-label={`${project.name} targets`}
            disallowEmptySelection
            selectedKeys={new Set([activeItemId])}
            selectionMode="single"
            onAction={(key) => {
              const value = String(key);

              if (value === 'workspace') {
                onSelectWorkspace();
                return;
              }

              if (value.startsWith('worktree:')) {
                onSelectWorktree(value.slice('worktree:'.length));
              }
            }}
            className="space-y-1"
          >
            <TreeNode
              id="workspace"
              label="Workspace"
              level={1}
              selected={selectedExplorerTarget.kind === 'workspace'}
              badge={project.kind === 'workspace' ? 'root' : undefined}
            />
            {worktrees.map((worktree) => (
            <TreeNode
              key={`worktree:${worktree.id}`}
              id={`worktree:${worktree.id}`}
              label={worktree.name}
              level={1}
              selected={
                selectedExplorerTarget.kind === 'worktree' &&
                selectedExplorerTarget.worktreeId === worktree.id
              }
              badge={
                worktree.status === 'broken'
                  ? 'broken'
                  : worktree.isBase
                    ? 'base'
                    : undefined
              }
              tone={
                worktree.status === 'broken'
                  ? 'broken'
                  : worktree.isBase
                    ? 'base'
                    : 'default'
              }
            />
          ))}
          </ListBox>
        </div>
      ) : (
        <Text className="px-3 py-2 text-sm text-zinc-500">
          No projects yet. Create one with the + button below.
        </Text>
      )}
    </ScrollShadow>
  );
}
