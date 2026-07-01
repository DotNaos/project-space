import { FolderKanban, Plus } from 'lucide-react';
import { Button, Text, ToggleButton, ToggleButtonGroup } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import type {
  ProjectGroupRecord,
  ProjectNavigationItem,
  ProjectSpaceRecord
} from '@/shared/project-space-api';
import { ProjectSpacesPicker } from './project-spaces-picker';

interface SpaceItem {
  id: string;
  kind: 'group' | 'project';
  label: string;
}

interface SpacesDockProps {
  items: SpaceItem[];
  activeItemId: string;
  canNavigateUp?: boolean;
  groups: ProjectGroupRecord[];
  onNavigateUp?(): void;
  onSelectProject(projectId: string, groupId?: string): void;
  onSelect(itemId: string): void;
  onCreate?(): void;
  projects: ProjectSpaceRecord[];
  rootItems: ProjectNavigationItem[];
  selectedProjectId: string;
}

const maxVisibleItems = 4;

function shortLabel(label: string) {
  const initials = label
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return initials || label.slice(0, 2).toUpperCase();
}

export function SpacesDock({
  items,
  activeItemId,
  canNavigateUp = false,
  groups,
  onNavigateUp,
  onSelectProject,
  onSelect,
  onCreate,
  projects,
  rootItems,
  selectedProjectId
}: SpacesDockProps) {
  const activeIndex = Math.max(
    items.findIndex((item) => item.id === activeItemId),
    0
  );
  const startIndex =
    items.length <= maxVisibleItems
      ? 0
      : Math.min(
          Math.max(activeIndex - Math.floor(maxVisibleItems / 2), 0),
          items.length - maxVisibleItems
        );
  const visibleItems = items.slice(startIndex, startIndex + maxVisibleItems);
  const hasLeadingOverflow = startIndex > 0;
  const hasTrailingOverflow = startIndex + maxVisibleItems < items.length;
  const activeItem = items.find((item) => item.id === activeItemId);

  return (
    <div className="border-t border-neutral-800 px-4 py-3">
      <ProjectSpacesPicker
        groups={groups}
        projects={projects}
        rootItems={rootItems}
        selectedProjectId={selectedProjectId}
        onSelectProject={onSelectProject}
      >
        <div className="grid w-full gap-2 rounded-2xl">
          <Button
            fullWidth
            variant="ghost"
            className="h-auto justify-start gap-2 rounded-xl px-2.5 py-2 text-left hover:bg-neutral-800/70"
          >
            <FolderKanban className="h-4 w-4 shrink-0 text-neutral-500" strokeWidth={1.8} />
            <span className="min-w-0 flex-1">
              <Text className="block truncate text-xs font-medium text-neutral-200">
                {activeItem?.label ?? 'Choose project'}
              </Text>
              <Text className="block truncate text-[11px] text-neutral-500">
                Switch project
              </Text>
            </span>
          </Button>

          <div className="flex w-full items-center justify-center gap-2 px-2 py-1">
          {canNavigateUp && onNavigateUp ? (
            <Button
              aria-label="Back to project root"
              isIconOnly
              size="sm"
              variant="ghost"
              onPress={onNavigateUp}
              className="h-7 w-7 min-w-0 rounded-[10px] px-0 text-sm leading-none text-neutral-500 transition hover:bg-neutral-800/70 hover:text-neutral-100"
            >
              ←
            </Button>
          ) : null}

          <div className="flex items-center gap-1">
            {hasLeadingOverflow ? (
              <Text className="px-1 text-[10px] font-semibold text-neutral-600">…</Text>
            ) : null}

            <ToggleButtonGroup
              disallowEmptySelection
              isDetached
              selectedKeys={new Set(activeItemId ? [activeItemId] : [])}
              selectionMode="single"
              size="sm"
              onSelectionChange={(keys) => {
                const [nextItemId] = keys;

                if (typeof nextItemId === 'string') {
                  onSelect(nextItemId);
                }
              }}
              className="rounded-[10px] bg-transparent"
            >
              {visibleItems.map((item) => {
                const active = activeItemId === item.id;

                return (
                  <ToggleButton
                    key={item.id}
                    id={item.id}
                    aria-label={item.label}
                    isIconOnly
                    variant="ghost"
                    className={cn(
                      'group h-7 w-7 min-w-0 rounded-[10px] px-0 transition',
                      active ? 'bg-neutral-800/90' : 'hover:bg-neutral-800/70'
                    )}
                  >
                    <span
                      className={cn(
                        'text-[10px] font-semibold tracking-[0.12em] transition',
                        active
                          ? 'text-neutral-100'
                          : 'text-neutral-500 group-hover:text-neutral-300'
                      )}
                    >
                      {shortLabel(item.label)}
                    </span>
                  </ToggleButton>
                );
              })}
            </ToggleButtonGroup>

            {hasTrailingOverflow ? (
              <Text className="px-1 text-[10px] font-semibold text-neutral-600">…</Text>
            ) : null}
          </div>

          {onCreate ? (
            <Button
              aria-label="Add project directory"
              isIconOnly
              size="sm"
              variant="ghost"
              onPress={onCreate}
              className="h-7 w-7 min-w-0 rounded-[10px] px-0 text-sm leading-none text-neutral-500 transition hover:bg-neutral-800/70 hover:text-neutral-100"
            >
              <Plus className="h-4 w-4" strokeWidth={1.8} />
            </Button>
          ) : null}
          </div>
        </div>
      </ProjectSpacesPicker>
    </div>
  );
}
