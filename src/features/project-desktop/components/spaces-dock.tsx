import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Text } from '@heroui/react';
import { Settings2 } from 'lucide-react';
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
  onOpenAppSettings(): void;
  projects: ProjectSpaceRecord[];
  rootItems: ProjectNavigationItem[];
  selectedProjectId: string;
}

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

function hoverInfluence(distance: number) {
  if (distance === 0) {
    return 1;
  }

  if (distance === 1) {
    return 0.52;
  }

  if (distance === 2) {
    return 0.2;
  }

  return 0;
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
  onOpenAppSettings,
  projects,
  rootItems,
  selectedProjectId
}: SpacesDockProps) {
  const [hoveredItemId, setHoveredItemId] = useState<string | null>(null);
  const [isDockHovered, setIsDockHovered] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const dockViewportRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const dragStateRef = useRef<{
    pointerId: number;
    startX: number;
    startScrollLeft: number;
    moved: boolean;
  } | null>(null);

  const activeIndex = Math.max(items.findIndex((item) => item.id === activeItemId), 0);
  const hoveredIndex = hoveredItemId
    ? items.findIndex((item) => item.id === hoveredItemId)
    : -1;
  const dockLeadIndex = hoveredIndex >= 0 ? hoveredIndex : activeIndex;
  const dockItems = useMemo(() => {
    return items.map((item, index) => {
      const distanceFromLead = dockLeadIndex >= 0 ? Math.abs(index - dockLeadIndex) : 99;
      const influence = isDockHovered ? hoverInfluence(distanceFromLead) : 0;
      const isActive = activeItemId === item.id;
      const size = 40 + (isActive ? 10 : 0) + influence * 22;
      const lift = (isActive ? 4 : 0) + influence * 10;
      const labelOpacity = 0.52 + influence * 0.34 + (isActive ? 0.18 : 0);

      return {
        ...item,
        isActive,
        size,
        lift,
        labelOpacity
      };
    });
  }, [activeItemId, dockLeadIndex, isDockHovered, items]);

  useEffect(() => {
    const viewport = dockViewportRef.current;
    const activeItem = itemRefs.current[activeItemId];

    if (!viewport || !activeItem) {
      return;
    }

    const viewportCenter = viewport.clientWidth / 2;
    const itemCenter = activeItem.offsetLeft + activeItem.offsetWidth / 2;
    const left = Math.max(itemCenter - viewportCenter, 0);

    viewport.scrollTo({
      left,
      behavior: 'smooth'
    });
  }, [activeItemId, dockItems]);

  function endDrag(pointerId?: number) {
    const viewport = dockViewportRef.current;
    const current = dragStateRef.current;

    if (viewport && current && (pointerId === undefined || current.pointerId === pointerId)) {
      viewport.releasePointerCapture(current.pointerId);
    }

    dragStateRef.current = null;
    setIsDragging(false);
  }

  return (
    <div className="border-t border-zinc-800 px-4 py-4">
      <div className="flex flex-col gap-3">
        <div className="relative flex h-20 items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Button
              aria-label="Open app settings"
              isIconOnly
              size="sm"
              variant="ghost"
              onPress={onOpenAppSettings}
              className="h-7 w-7 min-w-0 rounded-[10px] px-0 text-zinc-500 transition hover:bg-zinc-800/70 hover:text-zinc-100"
            >
              <Settings2 className="h-4 w-4" strokeWidth={1.9} />
            </Button>

            {canNavigateUp && onNavigateUp ? (
              <Button
                aria-label="Back to project root"
                isIconOnly
                size="sm"
                variant="ghost"
                onPress={onNavigateUp}
                className="h-7 w-7 min-w-0 rounded-[10px] px-0 text-sm leading-none text-zinc-500 transition hover:bg-zinc-800/70 hover:text-zinc-100"
              >
                ←
              </Button>
            ) : null}
          </div>

          <div className="pointer-events-none absolute inset-x-0 top-1/2 z-10 -translate-y-1/2 px-2">
            <div
              className={cn(
                'pointer-events-auto mx-auto flex items-center overflow-hidden rounded-[28px] transition-[width,padding,border-color,box-shadow,backdrop-filter,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]',
                isDockHovered || isDragging
                  ? 'border border-white/10 px-3 py-2.5 shadow-[0_18px_44px_rgba(0,0,0,0.34)] backdrop-blur-2xl'
                  : 'border border-transparent px-0 py-0 shadow-none backdrop-blur-none'
              )}
              style={{
                width: isDockHovered || isDragging ? '100%' : 'fit-content',
                maxWidth: '100%'
              }}
              onPointerEnter={() => {
                setIsDockHovered(true);
              }}
              onPointerLeave={() => {
                if (!isDragging) {
                  setIsDockHovered(false);
                  setHoveredItemId(null);
                }
              }}
            >
              <div
                ref={dockViewportRef}
                className={cn(
                  'flex min-w-0 max-w-full items-end gap-2 overflow-x-auto overflow-y-visible select-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
                  isDockHovered || isDragging ? 'w-full justify-center px-1 py-2' : 'w-auto justify-center px-0 py-0',
                  isDragging ? 'cursor-grabbing' : 'cursor-grab'
                )}
                onWheel={(event) => {
                  if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) {
                    return;
                  }

                  event.preventDefault();
                  event.currentTarget.scrollLeft += event.deltaY;
                }}
                onPointerDown={(event) => {
                  if (event.button !== 0) {
                    return;
                  }

                  dragStateRef.current = {
                    pointerId: event.pointerId,
                    startX: event.clientX,
                    startScrollLeft: event.currentTarget.scrollLeft,
                    moved: false
                  };
                  event.currentTarget.setPointerCapture(event.pointerId);
                  setIsDragging(false);
                }}
                onPointerMove={(event) => {
                  const current = dragStateRef.current;
                  if (!current || current.pointerId !== event.pointerId) {
                    return;
                  }

                  const delta = event.clientX - current.startX;
                  if (Math.abs(delta) > 4) {
                    current.moved = true;
                    setIsDragging(true);
                  }

                  event.currentTarget.scrollLeft = current.startScrollLeft - delta;
                }}
                onPointerUp={(event) => {
                  endDrag(event.pointerId);
                }}
                onPointerCancel={(event) => {
                  endDrag(event.pointerId);
                  setIsDockHovered(false);
                  setHoveredItemId(null);
                }}
              >
                {dockItems.map((item) => (
                  <button
                    key={item.id}
                    ref={(node) => {
                      itemRefs.current[item.id] = node;
                    }}
                    type="button"
                    aria-label={item.label}
                    onPointerEnter={() => {
                      setHoveredItemId(item.id);
                      setIsDockHovered(true);
                    }}
                    onFocus={() => {
                      setHoveredItemId(item.id);
                      setIsDockHovered(true);
                    }}
                    onClick={(event) => {
                      if (dragStateRef.current?.moved) {
                        event.preventDefault();
                        dragStateRef.current.moved = false;
                        return;
                      }

                      onSelect(item.id);
                    }}
                    className={cn(
                      'group relative shrink-0 rounded-[18px] border border-transparent text-zinc-300 outline-none transition-[transform,width,height,background-color,border-color,box-shadow,color] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]',
                      item.isActive
                        ? 'bg-zinc-800/92 text-zinc-50 shadow-[0_14px_34px_rgba(0,0,0,0.34),inset_0_1px_0_rgba(255,255,255,0.08)]'
                        : 'bg-zinc-900/18 hover:bg-zinc-800/48',
                      isDragging ? 'pointer-events-none' : null
                    )}
                    style={{
                      width: `${item.size}px`,
                      height: `${item.size}px`,
                      transform: `translateY(-${item.lift}px)`
                    }}
                  >
                    <span
                      className="flex h-full w-full items-center justify-center text-[12px] font-semibold transition-opacity duration-300"
                      style={{
                        opacity: item.labelOpacity
                      }}
                    >
                      {shortLabel(item.label)}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex items-center justify-end">
            {onCreate ? (
              <Button
                aria-label="Add project space"
                isIconOnly
                size="sm"
                variant="ghost"
                onPress={onCreate}
                className="h-7 w-7 min-w-0 rounded-[10px] px-0 text-sm leading-none text-zinc-500 transition hover:bg-zinc-800/70 hover:text-zinc-100"
              >
                +
              </Button>
            ) : null}
          </div>
        </div>

        <ProjectSpacesPicker
          groups={groups}
          projects={projects}
          rootItems={rootItems}
          selectedProjectId={selectedProjectId}
          onSelectProject={onSelectProject}
        />
      </div>
    </div>
  );
}
