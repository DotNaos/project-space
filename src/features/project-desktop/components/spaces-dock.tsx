import { Button, Text, ToggleButton, ToggleButtonGroup } from '@heroui/react';
import { cn } from '@/lib/utils';
import type {
  ProjectGroupRecord,
  ProjectNavigationItem,
  ProjectSpaceRecord
} from '@/shared/electron-api';
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

  return (
    <div className="border-t border-slate-800 px-4 py-4">
      <ProjectSpacesPicker
        groups={groups}
        projects={projects}
        rootItems={rootItems}
        selectedProjectId={selectedProjectId}
        onSelectProject={onSelectProject}
      >
        <div className="flex w-full items-center justify-center gap-2 rounded-2xl px-2 py-1">
          {canNavigateUp && onNavigateUp ? (
            <Button
              aria-label="Back to project root"
              isIconOnly
              size="sm"
              variant="ghost"
              onPress={onNavigateUp}
              className="h-7 w-7 min-w-0 rounded-[10px] px-0 text-sm leading-none text-slate-500 transition hover:bg-slate-800/70 hover:text-slate-100"
            >
              ←
            </Button>
          ) : null}

          <div className="flex items-center gap-1">
            {hasLeadingOverflow ? (
              <Text className="px-1 text-[10px] font-semibold text-slate-600">…</Text>
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
                      active ? 'bg-slate-800/90' : 'hover:bg-slate-800/70'
                    )}
                  >
                    <span
                      className={cn(
                        'text-[10px] font-semibold tracking-[0.12em] transition',
                        active
                          ? 'text-slate-100'
                          : 'text-slate-500 group-hover:text-slate-300'
                      )}
                    >
                      {shortLabel(item.label)}
                    </span>
                  </ToggleButton>
                );
              })}
            </ToggleButtonGroup>

            {hasTrailingOverflow ? (
              <Text className="px-1 text-[10px] font-semibold text-slate-600">…</Text>
            ) : null}
          </div>

          {onCreate ? (
            <Button
              aria-label="Add project space"
              isIconOnly
              size="sm"
              variant="ghost"
              onPress={onCreate}
              className="h-7 w-7 min-w-0 rounded-[10px] px-0 text-sm leading-none text-slate-500 transition hover:bg-slate-800/70 hover:text-slate-100"
            >
              +
            </Button>
          ) : null}
        </div>
      </ProjectSpacesPicker>
    </div>
  );
}
